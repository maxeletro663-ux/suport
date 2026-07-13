import axios from "axios";

// ── Sincronização com o PlugZBot (inbox unificado) ─────────────────────
// A Bia continua sendo dona do atendimento; isso só espelha as mensagens
// pro inbox do PlugZBot e permite que um humano assuma por lá (pausa a Bia).
// Se as env vars não estiverem configuradas, todas as funções viram no-op —
// nunca trava nem quebra o atendimento por falta de config ou por a API
// do PlugZBot estar fora do ar.

const BASE = process.env.PLUGZBOT_SYNC_URL ?? "";
const TOKEN = process.env.PLUGZBOT_SYNC_TOKEN ?? "";

export const plugzbotSyncConfigured = (): boolean => !!(BASE && TOKEN);

const client = () =>
  axios.create({
    baseURL: BASE,
    headers: { "X-Sync-Token": TOKEN, "Content-Type": "application/json" },
    timeout: 6_000,
  });

// Loga a mensagem recebida no inbox do PlugZBot e devolve o conversation_id.
export async function syncInbound(
  from: string,
  text: string,
  wamid?: string,
  profileName?: string,
): Promise<string | null> {
  if (!plugzbotSyncConfigured()) return null;
  try {
    const { data } = await client().post("/inbound", {
      from,
      text,
      wamid,
      profile_name: profileName || undefined,
    });
    return data?.conversation_id ?? null;
  } catch (e: any) {
    console.error("[suporte][plugzbot] falha ao sincronizar inbound:", e?.response?.data ?? e?.message ?? e);
    return null;
  }
}

// Pergunta ao PlugZBot se a Bia deve responder (false = humano assumiu pelo inbox).
// Falha de rede/timeout NUNCA pausa a Bia — sync é best-effort, não gate crítico.
export async function syncShouldRespond(conversationId: string | null): Promise<boolean> {
  if (!plugzbotSyncConfigured() || !conversationId) return true;
  try {
    const { data } = await client().get("/status", { params: { conversation_id: conversationId } });
    return data?.should_respond !== false;
  } catch (e: any) {
    console.error("[suporte][plugzbot] falha ao consultar status:", e?.response?.data ?? e?.message ?? e);
    return true;
  }
}

// Loga a resposta da Bia no inbox do PlugZBot.
export async function syncOutbound(to: string, text: string, wamid?: string): Promise<void> {
  if (!plugzbotSyncConfigured()) return;
  try {
    await client().post("/outbound", { to, text, wamid });
  } catch (e: any) {
    console.error("[suporte][plugzbot] falha ao sincronizar outbound:", e?.response?.data ?? e?.message ?? e);
  }
}
