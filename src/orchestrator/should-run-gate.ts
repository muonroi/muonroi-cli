// Keep the gate off pure chitchat, but ON for a resumed heavy task the classifier
// mislabels as chitchat (continuation phrases — preprocessor.ts:118-134). Reading
// STATE.md phase is the resume signal (execute phase = an active run).
export function shouldRunGate(
  pilCtx: { intentKind?: string | null; resumeDigest?: string | null; activeRunId?: string | null },
  readPhase: () => string | null,
): boolean {
  if (pilCtx.intentKind !== "chitchat") return true;
  if (pilCtx.resumeDigest || pilCtx.activeRunId) return true;
  try {
    return readPhase() === "execute";
  } catch (err) {
    // Missing/corrupt .planning is the normal "no active run" case, not an error — treat as no run.
    console.error(`[pil-gate] shouldRunGate readPhase failed (treating as no active run): ${(err as Error).message}`);
    return false;
  }
}
