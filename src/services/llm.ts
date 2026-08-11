/**
 * Camada de LLM — DeepSeek (API compatível com OpenAI).
 */

import axios from "axios";

// ─── Tipos de mensagem/tool (formato próprio, independente de SDK) ───────────
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlockParam = { type: "tool_result"; tool_use_id: string; content: string };
export type ContentBlock = TextBlock | ToolUseBlock;
export type MessageParam = { role: "user" | "assistant"; content: string | Array<ContentBlock | ToolResultBlockParam> };
export type Tool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
};

export type LLMResponse = {
  stop_reason: "end_turn" | "tool_use";
  content: ContentBlock[];
};

// ─── Conversão de mensagens (formato próprio) → OpenAI ───────────────────────
type OAIMessage = Record<string, unknown>;

function toOpenAIMessages(msgs: MessageParam[], system: string): OAIMessage[] {
  const result: OAIMessage[] = [{ role: "system", content: system }];

  for (const msg of msgs) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = msg.content as any[];

    if (msg.role === "user") {
      const toolResults = blocks.filter((b) => b.type === "tool_result");
      const textBlocks = blocks.filter((b) => b.type === "text");

      for (const tr of toolResults) {
        result.push({
          role: "tool",
          tool_call_id: tr.tool_use_id,
          content:
            typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
        });
      }
      if (textBlocks.length > 0) {
        result.push({ role: "user", content: textBlocks.map((b: any) => b.text).join("\n") });
      }
    } else {
      const textBlocks = blocks.filter((b) => b.type === "text");
      const toolUses = blocks.filter((b) => b.type === "tool_use");

      if (toolUses.length > 0) {
        result.push({
          role: "assistant",
          content: textBlocks.length > 0 ? textBlocks.map((b: any) => b.text).join("\n") : null,
          tool_calls: toolUses.map((b: any) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          })),
        });
      } else {
        result.push({
          role: "assistant",
          content: textBlocks.map((b: any) => b.text).join("\n"),
        });
      }
    }
  }

  return result;
}

// ─── Conversão de tools (formato próprio) → OpenAI ───────────────────────────
function toOpenAITools(tools: Tool[]): OAIMessage[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// ─── Chamada DeepSeek (API OpenAI-compatible) ────────────────────────────────
const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1/chat/completions";

export async function callLLM(params: {
  model: string;
  messages: MessageParam[];
  system: string;
  tools: Tool[];
  max_tokens: number;
  temperature: number;
  deepseekApiKey?: string;
}): Promise<LLMResponse> {
  const apiKey = params.deepseekApiKey || process.env.DEEPSEEK_API_KEY!;

  const { data } = await axios.post(
    DEEPSEEK_BASE_URL,
    {
      model: params.model,
      // deepseek-v4-flash roda em thinking mode por padrão, o que exige devolver
      // reasoning_content do turno anterior sempre que houve tool_call — nosso
      // formato de mensagem não carrega esse campo, então a 2a chamada do loop
      // agêntico quebrava com 400 (reasoning_content ausente).
      thinking: { type: "disabled" },
      messages: toOpenAIMessages(params.messages, params.system),
      tools: toOpenAITools(params.tools),
      tool_choice: "auto",
      temperature: params.temperature,
      max_tokens: params.max_tokens,
    },
    {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      timeout: 60_000,
    }
  );

  const choice = data.choices[0];
  const msg = choice.message;

  if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
    return {
      stop_reason: "tool_use",
      content: msg.tool_calls.map((tc: any) => ({
        type: "tool_use" as const,
        id: tc.id,
        name: tc.function.name,
        input: (() => {
          try { return JSON.parse(tc.function.arguments); } catch { return {}; }
        })(),
      })),
    };
  }

  return {
    stop_reason: "end_turn",
    content: [{ type: "text" as const, text: msg.content || "" }],
  };
}
