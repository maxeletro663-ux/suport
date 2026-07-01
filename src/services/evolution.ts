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
