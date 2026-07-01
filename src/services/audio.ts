// Transcrição de áudio (speech-to-text) via Groq Whisper — mesma abordagem
// dos outros agentes BarberZap. A Bia responde sempre em texto, então aqui só
// precisamos converter o áudio recebido em texto para alimentar o cérebro.
// Requer a secret GROQ_API_KEY no ambiente (EasyPanel).

export function transcriptionConfigured(): boolean {
  return !!process.env.GROQ_API_KEY;
}

export async function transcribeAudio(base64: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY ausente — transcrição de áudio desativada");

  const buffer = Buffer.from(base64, "base64");
  const blob = new Blob([buffer], { type: "audio/ogg" });

  const form = new globalThis.FormData();
  form.append("file", blob, "audio.ogg");
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "pt");
  form.append("response_format", "text");

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq transcription error: ${err}`);
  }

  return (await res.text()).trim();
}
