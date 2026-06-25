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
