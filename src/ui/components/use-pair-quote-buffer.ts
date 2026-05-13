import { useCallback, useRef } from "react";

/**
 * Hook: tracks the last rendered text per (pairKey, speakerRole) so the UI
 * can show a reply-quote header on the next turn in that pair.
 *
 * Ring buffer size = 1 per (pairKey, speaker) slot — we only need the most
 * recent turn, not a full history. Map key: `${pairKey}::${speakerRole}`.
 */
export function usePairQuoteBuffer() {
  const buf = useRef(new Map<string, string>());

  const store = useCallback((pairKey: string, speakerRole: string, text: string) => {
    buf.current.set(`${pairKey}::${speakerRole}`, text);
  }, []);

  const getPartnerLast = useCallback(
    (pairKey: string, partnerRole: string): string | undefined => buf.current.get(`${pairKey}::${partnerRole}`),
    [],
  );

  return { store, getPartnerLast };
}
