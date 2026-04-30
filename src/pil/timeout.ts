/**
 * src/pil/timeout.ts
 *
 * Promise.race timeout helper for the PIL pipeline.
 * Returns a promise that resolves to `value` after `ms` milliseconds.
 */

export function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
}
