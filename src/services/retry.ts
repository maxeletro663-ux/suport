// Retry com backoff exponencial — usado nas chamadas à API da Anthropic.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {},
): Promise<T> {
  const { attempts = 3, baseDelayMs = 1000, label = "op" } = opts;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = baseDelayMs * 2 ** i;
      console.warn(`[retry] ${label} falhou (tentativa ${i + 1}/${attempts}) — aguardando ${wait}ms`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
