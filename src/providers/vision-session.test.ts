import { beforeEach, describe, expect, it, vi } from "vitest";

const callVisionBackend = vi.fn();

vi.mock("./vision-backend.js", async () => {
  const actual = await vi.importActual<typeof import("./vision-backend.js")>("./vision-backend.js");
  return {
    ...actual,
    callVisionBackend: (...args: unknown[]) => callVisionBackend(...args),
    resolveAvailableVisionChain: async () => [{ provider: "test", model_id: "test-vl" }],
  };
});

const { __resetVisionSessions, askVisionSession, closeVisionSession, listVisionSessions, openVisionSession } =
  await import("./vision-session.js");

const IMAGE = { base64: "aGVsbG8=", mediaType: "image/png", label: "shot.png" };

/** Image parts present in the content array of the Nth backend call. */
function imagePartsOfCall(n: number): number {
  const content = callVisionBackend.mock.calls[n]![1] as Array<{ type: string }>;
  return content.filter((p) => p.type === "image_url").length;
}

beforeEach(() => {
  __resetVisionSessions();
  callVisionBackend.mockReset();
});

describe("vision sub-session", () => {
  it("reads the image once on open and keeps the session alive", async () => {
    callVisionBackend.mockResolvedValueOnce({ ok: true, text: "A blue gradient.", model: "m", provider: "p" });

    const opened = await openVisionSession({ images: [IMAGE], prompt: "Describe it." });

    expect(opened.ok).toBe(true);
    expect(opened.visionSessionId).toMatch(/^vs_/);
    expect(imagePartsOfCall(0)).toBe(1);
    // The envelope must tell the agent the session exists and how to release it.
    expect(opened.text).toContain(opened.visionSessionId!);
    expect(opened.text).toContain("vision_done");
    expect(listVisionSessions()).toHaveLength(1);
  });

  it("answers a follow-up WITHOUT re-sending the image", async () => {
    callVisionBackend
      .mockResolvedValueOnce({ ok: true, text: "A blue gradient with no text.", model: "m", provider: "p" })
      .mockResolvedValueOnce({ ok: true, text: "Blue is dominant.", model: "m", provider: "p" });

    const opened = await openVisionSession({ images: [IMAGE], prompt: "Describe it." });
    const answer = await askVisionSession(opened.visionSessionId!, "What is the dominant colour?");

    expect(answer?.ok).toBe(true);
    expect(answer?.reRead).toBe(false);
    expect(callVisionBackend).toHaveBeenCalledTimes(2);
    // THE point of the session: the follow-up carried zero image bytes.
    expect(imagePartsOfCall(1)).toBe(0);
    expect(answer?.text).toContain("Blue is dominant.");
  });

  it("re-attaches the image only when the sub-agent says it must look again", async () => {
    callVisionBackend
      .mockResolvedValueOnce({ ok: true, text: "A blue gradient.", model: "m", provider: "p" })
      .mockResolvedValueOnce({
        ok: true,
        text: "NEED_IMAGE: I did not record the corner badge.",
        model: "m",
        provider: "p",
      })
      .mockResolvedValueOnce({ ok: true, text: "The badge reads BETA.", model: "m", provider: "p" });

    const opened = await openVisionSession({ images: [IMAGE], prompt: "Describe it." });
    const answer = await askVisionSession(opened.visionSessionId!, "What does the corner badge say?");

    expect(answer?.reRead).toBe(true);
    expect(callVisionBackend).toHaveBeenCalledTimes(3);
    expect(imagePartsOfCall(1)).toBe(0); // text-only attempt
    expect(imagePartsOfCall(2)).toBe(1); // deliberate re-read
    expect(answer?.text).toContain("BETA");
  });

  it("carries prior Q&A into later follow-ups", async () => {
    callVisionBackend
      .mockResolvedValueOnce({ ok: true, text: "A blue gradient.", model: "m", provider: "p" })
      .mockResolvedValueOnce({ ok: true, text: "Blue.", model: "m", provider: "p" })
      .mockResolvedValueOnce({ ok: true, text: "Still blue.", model: "m", provider: "p" });

    const opened = await openVisionSession({ images: [IMAGE], prompt: "Describe it." });
    await askVisionSession(opened.visionSessionId!, "Dominant colour?");
    await askVisionSession(opened.visionSessionId!, "And the background?");

    const lastPrompt = (callVisionBackend.mock.calls[2]![1] as Array<{ text?: string }>)[0]!.text!;
    expect(lastPrompt).toContain("Dominant colour?");
    expect(lastPrompt).toContain("Blue.");
  });

  it("opens NO session when the backend cannot serve the image", async () => {
    callVisionBackend.mockResolvedValueOnce({ ok: false, reason: "HTTP 429 overloaded" });

    const opened = await openVisionSession({ images: [IMAGE], prompt: "Describe it." });

    expect(opened.ok).toBe(false);
    expect(opened.visionSessionId).toBeNull();
    expect(opened.text).toContain("could not be analyzed");
    expect(listVisionSessions()).toHaveLength(0);
  });

  it("closes on demand and reports how many follow-ups avoided a re-read", async () => {
    callVisionBackend
      .mockResolvedValueOnce({ ok: true, text: "A blue gradient.", model: "m", provider: "p" })
      .mockResolvedValueOnce({ ok: true, text: "Blue.", model: "m", provider: "p" });

    const opened = await openVisionSession({ images: [IMAGE], prompt: "Describe it." });
    await askVisionSession(opened.visionSessionId!, "Dominant colour?");
    const summary = closeVisionSession(opened.visionSessionId!);

    expect(summary).toMatchObject({ imageCount: 1, questionsAnswered: 1, cachedAnswers: 1, reReads: 0 });
    expect(listVisionSessions()).toHaveLength(0);
    // A closed session is gone — the caller must fall back, not resurrect it.
    expect(await askVisionSession(opened.visionSessionId!, "again?")).toBeNull();
  });
});
