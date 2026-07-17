// Estado da conversa: histórico, lock (evita processamento paralelo), debounce
// (agrupa mensagens rápidas) e — específico do SUPORTE — sessão de ativação,
// pausa por humano e eco do bot. Mesmo padrão do lovetag/chakal.
//
// Usa Upstash Redis quando configurado; senão, cai para memória em RAM.
import { Redis } from "@upstash/redis";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const HISTORY_TTL  = 60 * 60 * 24 * 3; // 3 dias
const MAX_MESSAGES = 20;
const LOCK_TTL     = 120;              // segundos
export const DEBOUNCE_TTL = 4;         // segundos para aguardar mensagens rápidas

const SESSION_TTL = 60 * 60 * 3;       // 3h — sessão de IA ativa (deslizante)
const BOT_ECHO_TTL = 120;              // janela p/ reconhecer o eco das mensagens da própria IA
const HUMAN_PAUSE_MINUTES = parseInt(process.env.HUMAN_PAUSE_MINUTES ?? "30", 10);

const useRedis = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
const redis = useRedis
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

// ── Fallback em memória ─────────────────────────────────────
const memHistory  = new Map<string, ChatMessage[]>();
const memLocks    = new Set<string>();
const memDebounce = new Map<string, string[]>();
const memWaiting  = new Set<string>();
const memKV       = new Map<string, { v: string; exp: number }>();

function memSet(key: string, v: string, exSec: number) {
  memKV.set(key, { v, exp: Date.now() + exSec * 1000 });
}
function memGet(key: string): string | null {
  const e = memKV.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { memKV.delete(key); return null; }
  return e.v;
}

// ── Histórico ───────────────────────────────────────────────
export async function getHistory(phone: string): Promise<ChatMessage[]> {
  try {
    if (redis) {
      const data = await redis.get<ChatMessage[]>(`sup:history:${phone}`);
      return (data ?? []).slice(-MAX_MESSAGES);
    }
    return (memHistory.get(phone) ?? []).slice(-MAX_MESSAGES);
  } catch (err) {
    console.error("[store] getHistory falhou:", err);
    return [];
  }
}

export async function appendMessages(phone: string, messages: ChatMessage[]): Promise<void> {
  try {
    const history = await getHistory(phone);
    const trimmed = [...history, ...messages].slice(-MAX_MESSAGES);
    if (redis) await redis.set(`sup:history:${phone}`, trimmed, { ex: HISTORY_TTL });
    else memHistory.set(phone, trimmed);
  } catch (err) {
    console.error("[store] appendMessages falhou:", err);
  }
}

export async function clearHistory(phone: string): Promise<void> {
  if (redis) await redis.del(`sup:history:${phone}`);
  else memHistory.delete(phone);
}

// ── Sessão de ativação (3h deslizante) ──────────────────────
export async function isActive(phone: string): Promise<boolean> {
  if (redis) return (await redis.exists(`sup:ativa:${phone}`)) === 1;
  return memGet(`sup:ativa:${phone}`) === "1";
}
export async function setActive(phone: string): Promise<void> {
  if (redis) await redis.set(`sup:ativa:${phone}`, "1", { ex: SESSION_TTL });
  else memSet(`sup:ativa:${phone}`, "1", SESSION_TTL);
}

// ── Aviso de número automático (evita repetir em menos de 1h) ─
const AUTO_NOTICE_TTL = 60 * 60; // 1h
export async function wasAutoNoticeSentRecently(phone: string): Promise<boolean> {
  if (redis) return (await redis.exists(`sup:autonotice:${phone}`)) === 1;
  return memGet(`sup:autonotice:${phone}`) === "1";
}
export async function markAutoNoticeSent(phone: string): Promise<void> {
  if (redis) await redis.set(`sup:autonotice:${phone}`, "1", { ex: AUTO_NOTICE_TTL });
  else memSet(`sup:autonotice:${phone}`, "1", AUTO_NOTICE_TTL);
}

// ── Pausa quando humano assume ──────────────────────────────
export async function isPaused(phone: string): Promise<boolean> {
  if (redis) return (await redis.exists(`sup:pausa:${phone}`)) === 1;
  return memGet(`sup:pausa:${phone}`) === "1";
}
export async function setPause(phone: string): Promise<void> {
  const ttl = HUMAN_PAUSE_MINUTES * 60;
  if (redis) await redis.set(`sup:pausa:${phone}`, "1", { ex: ttl });
  else memSet(`sup:pausa:${phone}`, "1", ttl);
}

// ── Eco do bot (p/ distinguir IA x humano em fromMe) ────────
export async function setBotEcho(phone: string, normalizedText: string): Promise<void> {
  const v = normalizedText.slice(0, 1500);
  if (redis) await redis.set(`sup:bot:${phone}`, v, { ex: BOT_ECHO_TTL });
  else memSet(`sup:bot:${phone}`, v, BOT_ECHO_TTL);
}
export async function getBotEcho(phone: string): Promise<string | null> {
  if (redis) return await redis.get<string>(`sup:bot:${phone}`);
  return memGet(`sup:bot:${phone}`);
}

// ── Lock ────────────────────────────────────────────────────
export async function acquireLock(phone: string): Promise<boolean> {
  if (redis) {
    const r = await redis.set(`sup:lock:${phone}`, "1", { nx: true, ex: LOCK_TTL });
    return r === "OK";
  }
  if (memLocks.has(phone)) return false;
  memLocks.add(phone);
  setTimeout(() => memLocks.delete(phone), LOCK_TTL * 1000);
  return true;
}
export async function releaseLock(phone: string): Promise<void> {
  if (redis) await redis.del(`sup:lock:${phone}`);
  else memLocks.delete(phone);
}

// ── Debounce ────────────────────────────────────────────────
export async function pushDebounce(phone: string, text: string): Promise<void> {
  if (redis) {
    await redis.rpush(`sup:debounce:${phone}`, text);
    await redis.expire(`sup:debounce:${phone}`, DEBOUNCE_TTL + 3);
  } else {
    memDebounce.set(phone, [...(memDebounce.get(phone) ?? []), text]);
  }
}
export async function flushDebounce(phone: string): Promise<string[]> {
  if (redis) {
    const key = `sup:debounce:${phone}`;
    const msgs = (await redis.lrange(key, 0, -1)) as string[];
    await redis.del(key);
    return msgs;
  }
  const msgs = memDebounce.get(phone) ?? [];
  memDebounce.delete(phone);
  return msgs;
}
export async function setDebounceWaiting(phone: string): Promise<void> {
  if (redis) await redis.set(`sup:waiting:${phone}`, "1", { ex: DEBOUNCE_TTL + 2 });
  else memWaiting.add(phone);
}
export async function isDebounceWaiting(phone: string): Promise<boolean> {
  if (redis) return (await redis.exists(`sup:waiting:${phone}`)) === 1;
  return memWaiting.has(phone);
}
export async function clearDebounceWaiting(phone: string): Promise<void> {
  if (redis) await redis.del(`sup:waiting:${phone}`);
  else memWaiting.delete(phone);
}

// ── Rate limit por minuto (anti-spam) ───────────────────────
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW = 60;
const memRate = new Map<string, { count: number; minute: number }>();

export async function checkRateLimit(phone: string): Promise<boolean> {
  const minute = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW);
  if (redis) {
    const key = `sup:rate:${phone}:${minute}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, RATE_LIMIT_WINDOW * 2);
    return count <= RATE_LIMIT_MAX;
  }
  const cur = memRate.get(phone);
  if (!cur || cur.minute !== minute) {
    memRate.set(phone, { count: 1, minute });
    return true;
  }
  cur.count++;
  return cur.count <= RATE_LIMIT_MAX;
}

// ── Anti-loop: texto enviado pelo bot recentemente ──────────
export async function setSentText(phone: string, normalizedText: string): Promise<void> {
  const key = `sup:sent:${phone}`;
  const v = normalizedText.slice(0, 1000);
  if (redis) await redis.set(key, v, { ex: 20 });
  else memSet(key, v, 20);
}

export async function getSentText(phone: string): Promise<string | null> {
  const key = `sup:sent:${phone}`;
  if (redis) return redis.get<string>(key);
  return memGet(key);
}

// ── Health ──────────────────────────────────────────────────
export async function pingStore(): Promise<boolean> {
  if (!redis) return true;
  try {
    await redis.set("sup:health", "1", { ex: 10 });
    return true;
  } catch {
    return false;
  }
}

export const storeBackend = useRedis ? "redis" : "memory";
