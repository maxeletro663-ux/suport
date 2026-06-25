import "dotenv/config";
import Fastify from "fastify";
import { runAgent, type UserCtx } from "./agent";
import { sendText, sendPresence } from "./services/evolution";
import {
  getHistory,
  appendMessages,
  clearHistory,
  acquireLock,
  releaseLock,
  pushDebounce,
  flushDebounce,
  setDebounceWaiting,
  isDebounceWaiting,
  clearDebounceWaiting,
  checkRateLimit,
  setSentText,
  getSentText,
  isActive,
  setActive,
  isPaused,
  setPause,
  setBotEcho,
  getBotEcho,
  pingStore,
  storeBackend,
  DEBOUNCE_TTL,
} from "./services/store";

function requireEnv(keys: string[]): void {
  const missing = keys.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`[suporte] variáveis de ambiente faltando: ${missing.join(", ")}`);
    process.exit(1);
  }
}
requireEnv([
  "ANTHROPIC_API_KEY",
  "EVOLUTION_API_URL",
  "EVOLUTION_API_KEY",
  "EVOLUTION_INSTANCE",
  "BARBERZAP_API_URL",
  "AGENT_LOOKUP_SECRET",
]);

const ACTIVATION_PHRASE = normalize(process.env.ACTIVATION_PHRASE ?? "preciso de ajuda com o barberzap");

const app = Fastify({ logger: { level: "info" } });

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  return (
    (message.conversation as string | undefined) ||
    (message.extendedTextMessage as { text?: string } | undefined)?.text ||
    ""
  );
}

function splitMessage(text: string, maxLen = 3500): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cut = remaining.lastIndexOf("\n", maxLen);
    const pos = cut > maxLen * 0.5 ? cut : maxLen;
    chunks.push(remaining.slice(0, pos).trimEnd());
    remaining = remaining.slice(pos).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function handleMessage(ctx: UserCtx, text: string): Promise<void> {
  const { jid, phone } = ctx;
  const trimmed = text.trim();
  if (!trimmed) return;

  if (trimmed.toLowerCase() === "/limpar") {
    await clearHistory(phone);
    await sendText(jid, "✅ Conversa reiniciada!");
    return;
  }

  // Debounce: agrupa mensagens enviadas em rápida sucessão
  await pushDebounce(phone, trimmed);
  if (await isDebounceWaiting(phone)) return;
  await setDebounceWaiting(phone);
  await new Promise((r) => setTimeout(r, DEBOUNCE_TTL * 1000));
  await clearDebounceWaiting(phone);

  // Lock: evita processamento paralelo do mesmo contato
  if (!(await acquireLock(phone))) {
    console.log(`[suporte] lock ativo para ${phone} — ignorando`);
    return;
  }

  try {
    const pending = await flushDebounce(phone);
    if (pending.length === 0) return;
    const fullMessage = pending.join("\n");

    await sendPresence(jid, 2000);

    const history = await getHistory(phone);
    const { text: reply, transfer } = await runAgent(ctx, history, fullMessage);

    await appendMessages(phone, [
      { role: "user", content: fullMessage },
      { role: "assistant", content: reply },
    ]);

    // Marca eco + anti-loop ANTES de enviar
    const normalizedReply = normalize(reply);
    await setBotEcho(phone, normalizedReply);
    await setSentText(phone, normalizedReply);

    for (const chunk of splitMessage(reply)) await sendText(jid, chunk);

    // Se a IA pediu transferência, pausa para o humano assumir
    if (transfer) {
      await setPause(phone);
      console.log(`[suporte] transferência → pausa para ${phone}`);
    }
  } catch (err) {
    console.error("[suporte] erro ao processar mensagem:", err);
    await sendText(jid, "Desculpa, tive um probleminha aqui 😅 Pode tentar de novo?");
  } finally {
    await releaseLock(phone);
  }
}

app.post("/webhook", async (request, reply) => {
  const ok200 = () => reply.code(200).send({ ok: true });
  const body = request.body as Record<string, unknown>;

  // Loga TODA entrada (diagnóstico) e aceita o evento em qualquer formato:
  // "messages.upsert" / "MESSAGES_UPSERT" / "messages_upsert".
  const ev = String(body?.event ?? "").toLowerCase().replace(/[._-]/g, "");
  const d0 = body?.data as Record<string, unknown> | undefined;
  const k0 = d0?.key as Record<string, unknown> | undefined;
  console.log(`[suporte] webhook event=${String(body?.event ?? "(vazio)")} type=${String(d0?.messageType ?? "-")} fromMe=${String(k0?.fromMe ?? "-")} jid=${String(k0?.remoteJid ?? "-")}`);

  if (ev && ev !== "messagesupsert") return ok200();

  const data = body.data as Record<string, unknown>;
  const key = data?.key as Record<string, unknown>;
  const message = data?.message as Record<string, unknown> | undefined;

  const rawJid = String(key?.remoteJid ?? "");
  const rawFromMe = key?.fromMe;
  const fromMe = rawFromMe === true || rawFromMe === "true";
  const messageType = String(data?.messageType ?? "");

  console.log(`[suporte] fromMe raw=${JSON.stringify(rawFromMe)} resolved=${fromMe}`);

  if (rawJid.endsWith("@g.us")) return ok200();
  if (rawJid === "status@broadcast") return ok200();
  if (messageType === "reactionMessage") return ok200();

  const phone = rawJid.replace(/@.*/, "").replace(/\D/g, "");
  if (!phone) return ok200();

  const text = extractText(message);

  // ── Mensagem do PRÓPRIO número (fromMe): IA x humano ──
  if (fromMe) {
    // Só interessa se há sessão de IA ativa com este contato.
    if (!(await isActive(phone))) return ok200();
    const sent = await getBotEcho(phone);
    const incoming = normalize(text);
    const isEcho = !!sent && !!incoming && normalize(sent).includes(incoming);
    if (!isEcho && incoming) {
      // Humano respondeu numa conversa que a IA atendia → pausa
      await setPause(phone);
      console.log(`[suporte] humano assumiu → pausa para ${phone}`);
    }
    return ok200();
  }

  // ── Anti-loop: se o texto bate com algo que o bot enviou recentemente, é eco ──
  if (text) {
    const sentByBot = await getSentText(phone);
    if (sentByBot) {
      const nIn = normalize(text);
      if (nIn && (sentByBot.includes(nIn.slice(0, 80)) || nIn.includes(sentByBot.slice(0, 80)))) {
        console.log(`[suporte] echo detectado (anti-loop) — ignorando ${phone}`);
        return ok200();
      }
    }
  }

  // ── Mensagem do CLIENTE ──
  if (await isPaused(phone)) {
    console.log(`[suporte] pausado (humano) — ignorando ${phone}`);
    return ok200();
  }

  if (!text || !text.trim()) {
    // Sem texto: só responde se já estiver em atendimento ativo.
    if (await isActive(phone)) {
      setImmediate(() =>
        sendText(rawJid, "Por enquanto consigo te ajudar por texto 🙂 Pode escrever sua dúvida?").catch(() => {}),
      );
    }
    return ok200();
  }

  // Trava de ativação: só começa com a frase do botão "Quero ajuda".
  const active = await isActive(phone);
  if (!active) {
    if (!normalize(text).includes(ACTIVATION_PHRASE)) {
      // Número usado por humanos/sem ativação → ignora.
      return ok200();
    }
    await setActive(phone);
    console.log(`[suporte] sessão ativada para ${phone}`);
  } else {
    await setActive(phone); // renova TTL deslizante
  }

  if (!(await checkRateLimit(phone))) {
    console.warn(`[suporte] rate limit atingido para ${phone}`);
    return ok200();
  }

  const ctx: UserCtx = { jid: rawJid, phone };
  setImmediate(() => {
    handleMessage(ctx, text).catch((err) => console.error("[suporte] erro inesperado:", err));
  });

  return ok200();
});

app.get("/health", async (_req, reply) => {
  const ok = await pingStore();
  return reply.code(ok ? 200 : 503).send({
    status: ok ? "ok" : "degraded",
    ts: new Date().toISOString(),
    instance: process.env.EVOLUTION_INSTANCE,
    store: storeBackend,
  });
});

const PORT = parseInt(process.env.PORT ?? "3000", 10);
app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`[suporte] 💈 Agente de suporte BarberZap na porta ${PORT} (memória: ${storeBackend})`);
});
