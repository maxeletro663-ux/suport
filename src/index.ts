import "dotenv/config";
import Fastify from "fastify";
import { runAgent, type UserCtx } from "./agent";
import { sendText, sendPresence, sendImage, sendImageUrl, getMediaBase64 } from "./services/evolution";
import { metaSendText, metaSendImage, metaSendImageUrl, metaVerifyToken, metaConfigured, metaDownloadMedia } from "./services/meta";
import { transcribeAudio, transcriptionConfigured } from "./services/audio";
import { consultarConta } from "./tools/contaLookup";
import {
  fetchUrlAsBase64,
  syncInbound,
  syncInboundMedia,
  syncOutbound,
  syncOutboundMedia,
  syncShouldRespond,
} from "./services/plugzbot";
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

const ACTIVATION_PHRASE = normalize(process.env.ACTIVATION_PHRASE ?? "Olá preciso de ajuda!");

// Botão da notificação oficial (Cloud API): payload/atalho que ativa a Bia.
const ACTIVATION_PAYLOAD = (process.env.SUPPORT_ACTIVATION_PAYLOAD ?? "SUPORTE_IA").toLowerCase();
// Frase canônica: qualquer clique no botão de suporte vira esta frase → ativa.
const ACTIVATION_CANONICAL = process.env.ACTIVATION_CANONICAL ?? "Olá preciso de ajuda!";
// Número (com DDI) que recebe o aviso quando a IA transfere para humano.
const HUMAN_NOTIFY_NUMBER = (process.env.HUMAN_NOTIFY_NUMBER ?? "5511937597009").replace(/\D/g, "");

// Saudação de boas-vindas (imagem + legenda) no primeiro contato da sessão.
const WELCOME_IMAGE_URL = process.env.WELCOME_IMAGE_URL
  ?? "https://app.appbarberzap.com.br/notificacoes/header-agendamento.jpg";
const WELCOME_CAPTION = process.env.WELCOME_CAPTION
  ?? "Oi! 👋 Eu sou a *Bia*, assistente virtual do BarberZap. Posso te ajudar com:\n\n💳 *Pagar ou renovar sua assinatura* (aqui no chat, via PIX)\n📅 *Consultar quando seu plano vence*\n⚙️ *Funcionalidades do app* (como usar cada parte)\n🏷️ *Planos e valores*\n🛠️ *Informar um problema* (aviso nosso time pra te ajudar)\n❓ *Tirar suas dúvidas*\n\nÉ só me dizer o que você precisa. E se preferir, a qualquer momento te passo para um atendente humano. 🙂";

const app = Fastify({ logger: { level: "info" } });

// Abstração de canal: a mesma Bia responde via Evolution OU Cloud API oficial.
interface Channel {
  name: "evolution" | "meta";
  clientName?: string;
  send: (text: string) => Promise<void>;
  sendImage?: (base64: string, caption?: string) => Promise<void>;
  sendImageUrl?: (url: string, caption?: string) => Promise<void>;
  presence?: (durationMs: number) => Promise<void>;
  // Presente (mesmo que null) só no canal Meta — é o gate pra sincronizar
  // com o inbox do PlugZBot (Evolution não tem conta correspondente lá).
  plugzbotConversationId?: string | null;
}

// Monta um transcript curto da conversa (últimas trocas) para o atendente humano.
function formatTranscript(
  messages: { role: string; content: string }[],
  maxMsgs = 10,
  maxLen = 240,
): string {
  return messages
    .slice(-maxMsgs)
    .map((m) => {
      const who = m.role === "user" ? "Cliente" : "Bia";
      let c = (m.content || "").replace(/\s+/g, " ").trim();
      if (c.length > maxLen) c = c.slice(0, maxLen) + "…";
      return c ? `${who}: ${c}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

// Aviso ao atendente humano (11937597009) via Evolution, ao transferir.
async function notifyHuman(
  phone: string,
  clientName: string | undefined,
  motivo: string | undefined,
  resumo: string | undefined,
  canal: string,
  transcript?: { role: string; content: string }[],
): Promise<void> {
  try {
    const conta = await consultarConta(phone).catch(() => "");
    const waCliente = `https://wa.me/${phone}`;
    const conversa = transcript && transcript.length ? formatTranscript(transcript) : "";
    const msg =
      `🆘 *Suporte BarberZap — pediram atendente humano*\n` +
      `Canal: ${canal}\n` +
      (clientName ? `Nome: ${clientName}\n` : "") +
      `WhatsApp: +${phone}\n` +
      (conta ? `Conta: ${conta}\n` : "") +
      (motivo ? `Motivo: ${motivo}\n` : "") +
      (resumo ? `Resumo: ${resumo}\n` : "") +
      (conversa ? `\n💬 *Conversa com a IA:*\n${conversa}\n` : "") +
      `\n👉 Falar com o cliente: ${waCliente}`;
    await sendText(HUMAN_NOTIFY_NUMBER, msg);
    console.log(`[suporte] aviso humano enviado p/ ${HUMAN_NOTIFY_NUMBER} (canal=${canal})`);
  } catch (err) {
    console.error("[suporte] falha ao avisar humano:", err);
  }
}

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

async function handleMessage(ctx: UserCtx, text: string, ch: Channel, justActivated = false): Promise<void> {
  const { phone } = ctx;
  const trimmed = text.trim();
  if (!trimmed) return;

  if (trimmed.toLowerCase() === "/limpar") {
    await clearHistory(phone);
    await ch.send("✅ Conversa reiniciada!");
    if (ch.plugzbotConversationId !== undefined) {
      await syncOutbound(phone, "✅ Conversa reiniciada!");
    }
    return;
  }

  // Primeiro contato da sessão: saudação com banner + legenda.
  if (justActivated && ch.sendImageUrl) {
    await ch.sendImageUrl(WELCOME_IMAGE_URL, WELCOME_CAPTION).catch((e) =>
      console.error("[suporte] falha ao enviar saudação:", e),
    );
    if (ch.plugzbotConversationId !== undefined) {
      const downloaded = await fetchUrlAsBase64(WELCOME_IMAGE_URL);
      if (downloaded) {
        await syncOutboundMedia(phone, "image", downloaded.base64, downloaded.mime, { caption: WELCOME_CAPTION });
      } else {
        await syncOutbound(phone, WELCOME_CAPTION); // fallback: pelo menos o texto sincroniza
      }
    }
    // Se a mensagem foi só a frase de ativação (sem dúvida real), a saudação basta.
    const remainder = normalize(trimmed).replace(ACTIVATION_PHRASE, "").trim();
    if (remainder.length < 6) {
      await appendMessages(phone, [
        { role: "user", content: trimmed },
        { role: "assistant", content: "[saudação enviada]" },
      ]);
      return;
    }
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

    // Humano assumiu pelo inbox do PlugZBot → não responde (só registra o que chegou).
    if (ch.plugzbotConversationId !== undefined) {
      const shouldRespond = await syncShouldRespond(ch.plugzbotConversationId);
      if (!shouldRespond) {
        console.log(`[suporte] pausado via PlugZBot (humano no inbox) — ignorando ${phone}`);
        await appendMessages(phone, [{ role: "user", content: fullMessage }]);
        return;
      }
    }

    if (ch.presence) await ch.presence(2000);

    const history = await getHistory(phone);
    const { text: reply, transfer, motivo, resumo, pixCopiaCola, pixImage } = await runAgent(ctx, history, fullMessage);

    await appendMessages(phone, [
      { role: "user", content: fullMessage },
      { role: "assistant", content: reply },
    ]);

    // Marca eco + anti-loop ANTES de enviar (relevante p/ Evolution).
    // Inclui o código PIX no eco para o próprio envio não ser confundido com humano.
    const normalizedReply = normalize(reply + (pixCopiaCola ? " " + pixCopiaCola : ""));
    await setBotEcho(phone, normalizedReply);
    await setSentText(phone, normalizedReply);

    for (const chunk of splitMessage(reply)) await ch.send(chunk);

    if (ch.plugzbotConversationId !== undefined) {
      await syncOutbound(phone, reply);
    }

    // Código copia-e-cola em mensagem PRÓPRIA e CRUA (cliente copia só o código;
    // não passa pela escrita da IA, evitando erro de transcrição que quebra o pagamento).
    if (pixCopiaCola) {
      await ch.send(pixCopiaCola);
      if (ch.plugzbotConversationId !== undefined) {
        await syncOutbound(phone, pixCopiaCola);
      }
    }

    // QR do PIX (imagem) — logo em seguida
    if (pixImage?.base64 && ch.sendImage) {
      await ch.sendImage(pixImage.base64, pixImage.caption).catch((e) =>
        console.error("[suporte] falha ao enviar QR:", e),
      );
      if (ch.plugzbotConversationId !== undefined) {
        await syncOutboundMedia(phone, "image", pixImage.base64, "image/png", { caption: pixImage.caption });
      }
    }

    // Se a IA pediu transferência: apenas AVISA a equipe (atendimento humano é
    // em OUTRO número). NÃO pausa — a Bia continua atendendo normalmente aqui.
    if (transfer) {
      const transcript: { role: string; content: string }[] = [
        ...history,
        { role: "user", content: fullMessage },
        { role: "assistant", content: reply },
      ];
      await notifyHuman(phone, ch.clientName, motivo, resumo, ch.name, transcript);
      console.log(`[suporte] transferência → aviso humano (sem pausa) (${phone}, canal=${ch.name})`);
    }
  } catch (err) {
    console.error("[suporte] erro ao processar mensagem:", err);
    await ch.send("Desculpa, tive um probleminha aqui 😅 Pode tentar de novo?");
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

  let text = extractText(message);

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

  // ── Áudio: transcreve (Groq Whisper) para a Bia entender ──
  // Só quando já há atendimento ativo — áudio não ativa a sessão (a ativação
  // depende da frase do botão "Quero ajuda").
  if (!text && messageType === "audioMessage" && key?.id && (await isActive(phone))) {
    if (transcriptionConfigured()) {
      try {
        const b64 = await getMediaBase64(String(key.id), rawJid);
        if (b64) {
          text = await transcribeAudio(b64);
          console.log(`[suporte] áudio transcrito: "${text.slice(0, 60)}"`);
        }
      } catch (e) {
        console.error("[suporte] erro ao transcrever áudio:", e);
      }
    }
    // Se não deu para transcrever, o fallback de "texto vazio" logo abaixo
    // pede gentilmente que escreva.
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
  let justActivated = false;
  if (!active) {
    if (!normalize(text).includes(ACTIVATION_PHRASE)) {
      // Número usado por humanos/sem ativação → ignora.
      return ok200();
    }
    await setActive(phone);
    justActivated = true;
    console.log(`[suporte] sessão ativada para ${phone}`);
  } else {
    await setActive(phone); // renova TTL deslizante
  }

  if (!(await checkRateLimit(phone))) {
    console.warn(`[suporte] rate limit atingido para ${phone}`);
    return ok200();
  }

  const ctx: UserCtx = { jid: rawJid, phone, channel: "evolution" };
  const pushName = String((data as Record<string, unknown>)?.pushName ?? "");
  const ch: Channel = {
    name: "evolution",
    clientName: pushName,
    send: (t) => sendText(rawJid, t),
    sendImage: (b64, cap) => sendImage(rawJid, b64, cap),
    sendImageUrl: (url, cap) => sendImageUrl(rawJid, url, cap),
    presence: (ms) => sendPresence(rawJid, ms),
  };
  setImmediate(() => {
    handleMessage(ctx, text, ch, justActivated).catch((err) => console.error("[suporte] erro inesperado:", err));
  });

  return ok200();
});

// ── Webhook da Cloud API oficial (Meta) ────────────────────────────────
// Verificação do webhook (handshake GET hub.challenge).
app.get("/webhook/meta", async (request, reply) => {
  const q = request.query as Record<string, string>;
  const mode = q["hub.mode"];
  const token = q["hub.verify_token"];
  const challenge = q["hub.challenge"];
  if (mode === "subscribe" && token && token === metaVerifyToken()) {
    return reply.code(200).send(challenge ?? "");
  }
  return reply.code(403).send("forbidden");
});

// Processa 1 mensagem recebida pela Cloud API (rodado via setImmediate — nunca
// bloqueia o ack do webhook, mesmo com transcrição de áudio ou sync lento).
async function processMetaMessage(
  from: string,
  phone: string,
  clientName: string,
  wamid: string | undefined,
  m: Record<string, any>,
): Promise<void> {
  // Extrai texto / detecta clique no botão de suporte
  let text = "";
  if (m.type === "text") {
    text = m.text?.body ?? "";
  } else if (m.type === "button") {
    const payload = String(m.button?.payload ?? "").toLowerCase();
    const btext = m.button?.text ?? "";
    text = (payload === ACTIVATION_PAYLOAD || /ajuda|suporte/.test(normalize(btext)))
      ? ACTIVATION_CANONICAL : btext;
  } else if (m.type === "interactive") {
    const br = m.interactive?.button_reply ?? m.interactive?.list_reply ?? {};
    const id = String(br.id ?? "").toLowerCase();
    const title = br.title ?? "";
    text = (id === ACTIVATION_PAYLOAD || /ajuda|suporte/.test(normalize(title)))
      ? ACTIVATION_CANONICAL : title;
  } else if (m.type === "audio") {
    // Áudio só em atendimento ativo (não ativa a sessão) e sem pausa.
    if (await isPaused(phone)) return;
    if (!(await isActive(phone))) return;
    const mediaId = String(m.audio?.id ?? "");
    if (!mediaId || !transcriptionConfigured()) return;
    try {
      const downloaded = await metaDownloadMedia(mediaId);
      if (downloaded) {
        text = await transcribeAudio(downloaded.base64);
        console.log(`[suporte][meta] áudio transcrito: "${text.slice(0, 60)}"`);
      }
    } catch (e) {
      console.error("[suporte][meta] erro ao transcrever áudio:", e);
    }
    if (!text.trim()) {
      await metaSendText(from, "Não consegui entender o áudio 😅 Pode escrever sua dúvida?").catch(() => {});
      return;
    }
  } else if (m.type === "image" || m.type === "video" || m.type === "document" || m.type === "sticker") {
    // A Bia não tem visão — só sincroniza a mídia pro inbox do PlugZBot pra
    // um humano ver (sem responder nada por aqui).
    const mediaId = String(m[m.type]?.id ?? "");
    if (mediaId) {
      const downloaded = await metaDownloadMedia(mediaId);
      if (downloaded) {
        syncInboundMedia(phone, m.type, downloaded.base64, downloaded.mime, {
          wamid,
          filename: m.document?.filename,
          profileName: clientName,
        }).catch((e) => console.error("[suporte][plugzbot] erro ao sincronizar mídia:", e));
      }
    }
    return;
  } else {
    return; // outros tipos de mídia: ignora por enquanto
  }
  if (!text.trim()) {
    console.log(`[suporte][meta] mensagem sem texto útil (type=${m.type}) — ignorando`);
    return;
  }
  console.log(`[suporte][meta] texto extraído de ${phone}: "${text.slice(0, 80)}"`);

  // Sincroniza no inbox do PlugZBot — loga TODA mensagem de texto real que
  // chega no número, independente de ativar a Bia ou não (visibilidade total).
  const plugzbotConversationId = await syncInbound(phone, text, wamid, clientName);

  // Gating de ativação (Cloud API não tem fromMe/eco)
  if (await isPaused(phone)) {
    console.log(`[suporte][meta] ${phone} está pausado (humano assumiu) — ignorando`);
    return;
  }
  const active = await isActive(phone);
  let justActivated = false;
  if (!active) {
    if (!normalize(text).includes(ACTIVATION_PHRASE)) {
      console.log(`[suporte][meta] ${phone} sem sessão ativa e frase de ativação não bateu — ignorando`);
      return;
    }
    await setActive(phone);
    justActivated = true;
    console.log(`[suporte][meta] sessão ativada para ${phone}`);
  } else {
    await setActive(phone);
  }
  if (!(await checkRateLimit(phone))) {
    console.warn(`[suporte][meta] rate limit atingido para ${phone}`);
    return;
  }

  const ctx: UserCtx = { jid: from, phone, channel: "meta" };
  const ch: Channel = {
    name: "meta",
    clientName,
    send: (t) => metaSendText(from, t),
    sendImage: (b64, cap) => metaSendImage(from, b64, cap),
    sendImageUrl: (url, cap) => metaSendImageUrl(from, url, cap),
    plugzbotConversationId,
  };
  await handleMessage(ctx, text, ch, justActivated);
}

// Recebe mensagens da Cloud API e responde com a mesma Bia.
app.post("/webhook/meta", async (request, reply) => {
  const ok200 = () => reply.code(200).send({ ok: true });
  const body = request.body as Record<string, any>;
  const entryCount = Array.isArray(body?.entry) ? body.entry.length : 0;
  console.log(`[suporte][meta] webhook POST recebido — entries=${entryCount}`);
  if (!Array.isArray(body?.entry)) return ok200();

  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const msgCount = Array.isArray(value.messages) ? value.messages.length : 0;
        console.log(`[suporte][meta] change field=${change.field} messages=${msgCount} statuses=${Array.isArray(value.statuses) ? value.statuses.length : 0}`);
        // Ignora eventos de status (sent/delivered/read) — só tratamos mensagens.
        if (!Array.isArray(value.messages)) continue;
        const contacts: any[] = value.contacts ?? [];

        for (const m of value.messages) {
          const from = String(m.from ?? "");
          if (!from) continue;
          const phone = from.replace(/\D/g, "");
          if (!phone) continue;
          const clientName = contacts.find((c) => c.wa_id === from)?.profile?.name ?? "";
          const wamid = m.id ? String(m.id) : undefined;

          setImmediate(() => {
            processMetaMessage(from, phone, clientName, wamid, m).catch((err) =>
              console.error("[suporte][meta] erro ao processar mensagem:", err),
            );
          });
        }
      }
    }
  } catch (err) {
    console.error("[suporte][meta] erro no webhook:", err);
  }

  return ok200();
});

// Confirmação de pagamento — chamado pelo mp-webhook (só p/ PIX gerado pela IA).
app.post("/pix-confirmado", async (request, reply) => {
  const body = request.body as Record<string, any>;
  const secret = process.env.AGENT_LOOKUP_SECRET;
  if (!secret || body?.secret !== secret) {
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  }

  const phone = String(body?.phone ?? "").replace(/\D/g, "");
  const channel = body?.channel === "meta" ? "meta" : "evolution";
  if (!phone) return reply.code(400).send({ ok: false, error: "phone obrigatório" });

  const msg =
    `✅ *Pagamento confirmado!*\n\n` +
    `Recebemos seu PIX e sua conta BarberZap já foi *reativada*. 🎉\n\n` +
    `Já pode usar o app normalmente. Qualquer coisa, é só chamar. 😊`;

  try {
    if (channel === "meta") {
      await metaSendText(phone, msg);
    } else {
      await sendText(phone, msg);
    }
    // Encerra a pausa de "humano" se houver — a conversa pode seguir normal.
    console.log(`[suporte] confirmação de pagamento enviada (${channel}) p/ ${phone}`);
    return reply.code(200).send({ ok: true });
  } catch (err) {
    console.error("[suporte] erro ao enviar confirmação de pagamento:", err);
    return reply.code(200).send({ ok: false });
  }
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
  console.log(
    `[suporte] 💈 Agente de suporte BarberZap na porta ${PORT} ` +
    `(memória: ${storeBackend} | Cloud API: ${metaConfigured() ? "configurada" : "off"} | aviso humano: ${HUMAN_NOTIFY_NUMBER})`,
  );
});
