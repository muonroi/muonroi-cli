export async function withRateLimitBackoff<T>(
  fn: () => Promise<T>,
  opts: { delays?: number[]; maxRetries?: number } = {},
): Promise<T> {
  const delays = opts.delays ?? [1000, 4000, 16000];
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? e ?? "");
      const is429 = e?.status === 429 || /429|rate.?limit/i.test(msg);
      if (!is429 || attempt === maxRetries - 1) throw e;
      const ms = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((r) => setTimeout(r, ms));
    }
  }
  throw lastErr;
}
