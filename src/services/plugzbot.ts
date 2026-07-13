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

// Loga mídia recebida (imagem/vídeo/documento/figurinha) no inbox do PlugZBot.
// A Bia não "vê" a mídia (sem visão) — isso é só pra visibilidade no inbox,
// não aciona nenhuma resposta.
export async function syncInboundMedia(
  from: string,
  type: "image" | "audio" | "video" | "document" | "sticker",
  base64: string,
  mime: string,
  opts: { wamid?: string; filename?: string; profileName?: string } = {},
): Promise<void> {
  if (!plugzbotSyncConfigured()) return;
  try {
    const buffer = Buffer.from(base64, "base64");
    const form = new FormData();
    form.append("from", from);
    if (opts.wamid) form.append("wamid", opts.wamid);
    if (opts.profileName) form.append("profile_name", opts.profileName);
    form.append("file", new Blob([buffer], { type: mime }), opts.filename || "media");
    // Sem Content-Type manual aqui (nem via client(), que fixa application/json
    // por padrão) — o axios define sozinho o boundary correto do multipart
    // a partir do FormData, igual já funciona em metaSendImage.
    await axios.post(`${BASE}/inbound-media?type=${type}`, form, {
      headers: { "X-Sync-Token": TOKEN },
      timeout: 20_000,
      maxBodyLength: Infinity,
    });
  } catch (e: any) {
    console.error("[suporte][plugzbot] falha ao sincronizar mídia inbound:", e?.response?.data ?? e?.message ?? e);
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

// Loga mídia enviada pela Bia (saudação em imagem, QR do PIX etc.) no inbox
// do PlugZBot — antes só a legenda em texto ia, a imagem em si nunca aparecia.
export async function syncOutboundMedia(
  to: string,
  type: "image" | "audio" | "video" | "document" | "sticker",
  base64: string,
  mime: string,
  opts: { wamid?: string; caption?: string; filename?: string } = {},
): Promise<void> {
  if (!plugzbotSyncConfigured()) return;
  try {
    const buffer = Buffer.from(base64, "base64");
    const form = new FormData();
    form.append("to", to);
    if (opts.wamid) form.append("wamid", opts.wamid);
    if (opts.caption) form.append("caption", opts.caption);
    form.append("file", new Blob([buffer], { type: mime }), opts.filename || "media");
    await axios.post(`${BASE}/outbound-media?type=${type}`, form, {
      headers: { "X-Sync-Token": TOKEN },
      timeout: 20_000,
      maxBodyLength: Infinity,
    });
  } catch (e: any) {
    console.error("[suporte][plugzbot] falha ao sincronizar mídia outbound:", e?.response?.data ?? e?.message ?? e);
  }
}

// Baixa uma URL externa (ex.: banner de saudação, que a Bia manda direto por
// URL pra Meta sem baixar localmente) em base64, só pra poder sincronizar.
export async function fetchUrlAsBase64(url: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 15_000 });
    const mime = String(res.headers["content-type"] || "image/jpeg").split(";")[0].trim();
    return { base64: Buffer.from(res.data).toString("base64"), mime };
  } catch (e: any) {
    console.error("[suporte][plugzbot] falha ao baixar URL pra sincronizar:", e?.message ?? e);
    return null;
  }
}
