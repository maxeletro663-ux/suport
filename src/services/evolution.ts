import axios from "axios";

// Cliente da Evolution API — instância do número de suporte (ex.: "Ativa").
const api = axios.create({
  baseURL: process.env.EVOLUTION_API_URL!,
  headers: {
    apikey: process.env.EVOLUTION_API_KEY!,
    "Content-Type": "application/json",
  },
  timeout: 30_000,
});

const INSTANCE = () => process.env.EVOLUTION_INSTANCE!;

export async function sendText(jid: string, text: string): Promise<void> {
  const inst = INSTANCE();
  await api.post(`/message/sendText/${inst}`, { number: jid, text });
}

export async function sendPresence(jid: string, durationMs = 2000): Promise<void> {
  const inst = INSTANCE();
  try {
    await api.post(`/chat/sendPresence/${inst}`, {
      number: jid,
      options: { presence: "composing", delay: durationMs },
    });
  } catch {
    // não crítico
  }
}

// Envia uma imagem a partir de base64 (ex.: QR do PIX).
export async function sendImage(jid: string, base64: string, caption = ""): Promise<void> {
  const inst = INSTANCE();
  await api.post(`/message/sendMedia/${inst}`, {
    number: jid,
    mediatype: "image",
    mimetype: "image/png",
    media: base64,
    fileName: "pix-qr.png",
    caption,
  });
}

// Baixa o base64 de uma mídia recebida (ex.: áudio) para transcrição.
export async function getMediaBase64(messageId: string, jid: string): Promise<string | null> {
  const inst = INSTANCE();
  try {
    const res = await api.post(`/chat/getBase64FromMediaMessage/${inst}`, {
      message: { key: { id: messageId, remoteJid: jid, fromMe: false } },
    });
    // Evolution pode retornar { base64 } ou { data: { base64 } }.
    const data = res.data as Record<string, unknown>;
    const nested = data?.data as Record<string, unknown> | undefined;
    return (data?.base64 || nested?.base64 || null) as string | null;
  } catch (e: any) {
    console.error("[suporte][evolution] erro ao baixar mídia:", e?.response?.data ?? e?.message ?? e);
    return null;
  }
}

// Envia uma imagem a partir de uma URL pública (ex.: banner de saudação).
export async function sendImageUrl(jid: string, url: string, caption = ""): Promise<void> {
  const inst = INSTANCE();
  await api.post(`/message/sendMedia/${inst}`, {
    number: jid,
    mediatype: "image",
    media: url,
    caption,
  });
}
