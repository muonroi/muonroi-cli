/**
 * Persistent vision sub-session — the "sight sub-agent" for a text-only primary.
 *
 * ## Why this exists
 *
 * Every vision call used to be stateless: `ask_vision_proxy` re-uploaded the
 * full base64 image AND re-ran the whole "analyze this screenshot" prompt for
 * every single follow-up question. Five questions about one screenshot meant
 * five full re-reads — five uploads, five cold analyses, five times the latency
 * and cost, and five subtly different descriptions of the same pixels (the main
 * agent then had to reconcile them).
 *
 * A vision session is a SEPARATE, long-lived conversation that owns the images:
 *
 *   1. `openVisionSession` reads the image ONCE and returns the observation the
 *      main agent treats as its own sight.
 *   2. `askVisionSession` answers follow-ups from that session's accumulated
 *      transcript — WITHOUT re-sending the image bytes. The sub-agent already
 *      described what it saw; most follow-ups ("what colour is the header?",
 *      "what does the error say?") are answerable from its own notes.
 *   3. When they genuinely are not, the sub-agent replies with the
 *      `NEED_IMAGE:` sentinel and this module re-issues that ONE question with
 *      the pixels attached. A re-read becomes a deliberate, counted event
 *      instead of the default.
 *   4. The session lives until the main agent calls `closeVisionSession`
 *      ("done"), with a TTL + LRU cap as a backstop so a forgotten session
 *      cannot pin image bytes in memory forever.
 *
 * The backend itself is stateless HTTP, so "the sub-agent stays alive" means:
 * its conversation is retained here and replayed as text. That is precisely the
 * part worth keeping — the expensive part was never the socket, it was
 * re-analysing the picture.
 */
import { randomUUID } from "node:crypto";
import {
  callVisionBackend,
  formatNativeVisionObservation,
  formatNativeVisionUnavailable,
  looksLikeOcrIntent,
  resolveAvailableVisionChain,
  type VisionTaskKind,
  wrapAnalyzerInstructions,
} from "./vision-backend.js";

export interface VisionSessionImage {
  base64: string;
  mediaType: string;
  /** Human label for logs / listings (file name, tool source, cache id). */
  label: string;
}

interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

interface VisionSession {
  id: string;
  images: VisionSessionImage[];
  kind: VisionTaskKind;
  /** Q&A after the opening observation — replayed as text on every follow-up. */
  transcript: TranscriptTurn[];
  openedAt: number;
  lastUsedAt: number;
  /** How many follow-ups needed the pixels re-attached. Reported on close. */
  reReads: number;
  /** Follow-ups answered from the transcript alone — the whole point. */
  cachedAnswers: number;
}

/** Idle timeout. A session the main agent forgot to close cannot leak past this. */
const SESSION_TTL_MS = 30 * 60_000;
/** Concurrent sessions; the least-recently-used is evicted past this. */
const MAX_SESSIONS = 8;
/** Sentinel the sub-agent emits when the transcript genuinely is not enough. */
const NEED_IMAGE_SENTINEL = "NEED_IMAGE";

const sessions = new Map<string, VisionSession>();

function sweep(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsedAt > SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size > MAX_SESSIONS) {
    let oldestId: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, s] of sessions) {
      if (s.lastUsedAt < oldestAt) {
        oldestAt = s.lastUsedAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    sessions.delete(oldestId);
  }
}

export interface OpenVisionSessionOpts {
  images: VisionSessionImage[];
  /** Opening analysis prompt (built by the caller — design / OCR / default). */
  prompt: string;
  kind?: VisionTaskKind;
  /** Ask the backend for a JSON object (design-contract extraction). */
  responseFormat?: { type: "json_object" };
  signal?: AbortSignal;
  /** CLI session id, for `usage forensics` attribution. */
  sessionId?: string;
}

export interface OpenVisionSessionResult {
  /** Null when no backend could serve the images — `text` explains why. */
  visionSessionId: string | null;
  /** Ready-to-inject `<vision-observation>` envelope. */
  text: string;
  /**
   * The backend's raw observation, unwrapped. Callers that own extra envelope
   * metadata (the tool path also has cached image ids) re-format it themselves
   * rather than losing those hints to a pre-built envelope.
   */
  raw: string;
  ok: boolean;
}

/**
 * Read the images once and open a session that can answer follow-ups without
 * re-reading them. On backend failure NO session is opened (there is nothing to
 * follow up on) and the caller gets the standard unavailable envelope.
 */
export async function openVisionSession(opts: OpenVisionSessionOpts): Promise<OpenVisionSessionResult> {
  sweep();
  const kind = opts.kind ?? "default";
  const content: Array<Record<string, unknown>> = [
    { type: "text", text: wrapAnalyzerInstructions(opts.prompt, kind) },
    ...opts.images.map((img) => ({
      type: "image_url",
      image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: "high" },
    })),
  ];

  const result = await callVisionBackend(
    await resolveAvailableVisionChain(kind),
    content,
    opts.signal,
    opts.responseFormat,
    { sessionId: opts.sessionId },
  );

  if (!result.ok) {
    return {
      visionSessionId: null,
      ok: false,
      raw: "",
      text: formatNativeVisionUnavailable(opts.images.length, [result.reason]),
    };
  }

  const id = `vs_${randomUUID().slice(0, 8)}`;
  const now = Date.now();
  sessions.set(id, {
    id,
    images: opts.images,
    kind,
    transcript: [
      { role: "user", text: opts.prompt },
      { role: "assistant", text: result.text },
    ],
    openedAt: now,
    lastUsedAt: now,
    reReads: 0,
    cachedAnswers: 0,
  });

  return {
    visionSessionId: id,
    ok: true,
    raw: result.text,
    text: formatNativeVisionObservation(result.text, { imageCount: opts.images.length, visionSessionId: id }),
  };
}

export interface AskVisionSessionResult {
  text: string;
  ok: boolean;
  /** True when the pixels had to be re-attached for this question. */
  reRead: boolean;
}

/**
 * Ask a follow-up inside an open session.
 *
 * Pass 1 replays the transcript as TEXT ONLY. The sub-agent is told to answer
 * from what it already saw, and to emit `NEED_IMAGE: <what it must re-check>`
 * rather than guess. Pass 2 fires only on that sentinel and re-attaches the
 * images for that single question.
 */
export async function askVisionSession(
  visionSessionId: string,
  question: string,
  opts?: { signal?: AbortSignal; sessionId?: string },
): Promise<AskVisionSessionResult | null> {
  sweep();
  const session = sessions.get(visionSessionId);
  if (!session) return null;
  session.lastUsedAt = Date.now();

  const kind: VisionTaskKind = looksLikeOcrIntent(question) ? "ocr" : session.kind;
  const chain = await resolveAvailableVisionChain(kind);

  const recallText = [
    `You already examined ${session.images.length === 1 ? "an image" : `${session.images.length} images`} and reported the following. `,
    `Answer the new question from these notes when they are sufficient.`,
    "",
    ...session.transcript.map((t) => (t.role === "user" ? `Q: ${t.text}` : `You: ${t.text}`)),
    "",
    `New question: ${question}`,
    "",
    `If — and ONLY if — your notes above genuinely cannot answer this (you need to look at a region, colour, or text you did not record), reply with exactly:`,
    `${NEED_IMAGE_SENTINEL}: <one line naming what you must re-check>`,
    `Never guess at visual detail you did not record. Otherwise answer directly.`,
  ].join("\n");

  const textOnly = await callVisionBackend(
    chain,
    [{ type: "text", text: wrapAnalyzerInstructions(recallText, kind) }],
    opts?.signal,
    undefined,
    { sessionId: opts?.sessionId },
  );

  if (textOnly.ok && !textOnly.text.trim().startsWith(NEED_IMAGE_SENTINEL)) {
    session.transcript.push({ role: "user", text: question }, { role: "assistant", text: textOnly.text });
    session.cachedAnswers++;
    return {
      ok: true,
      reRead: false,
      text: formatNativeVisionObservation(textOnly.text, {
        imageCount: session.images.length,
        visionSessionId: session.id,
      }),
    };
  }

  // Either the sub-agent asked to look again, or the text-only pass failed —
  // both mean: re-attach the pixels for this ONE question.
  const withImages = await callVisionBackend(
    chain,
    [
      {
        type: "text",
        text: wrapAnalyzerInstructions(
          [
            `You examined ${session.images.length === 1 ? "this image" : "these images"} before. Your earlier notes:`,
            "",
            ...session.transcript.map((t) => (t.role === "user" ? `Q: ${t.text}` : `You: ${t.text}`)),
            "",
            `Now look again and answer: ${question}`,
          ].join("\n"),
          kind,
        ),
      },
      ...session.images.map((img) => ({
        type: "image_url",
        image_url: { url: `data:${img.mediaType};base64,${img.base64}`, detail: "high" },
      })),
    ],
    opts?.signal,
    undefined,
    { sessionId: opts?.sessionId },
  );

  if (!withImages.ok) {
    return {
      ok: false,
      reRead: true,
      text: formatNativeVisionUnavailable(session.images.length, [withImages.reason]),
    };
  }

  session.transcript.push({ role: "user", text: question }, { role: "assistant", text: withImages.text });
  session.reReads++;
  return {
    ok: true,
    reRead: true,
    text: formatNativeVisionObservation(withImages.text, {
      imageCount: session.images.length,
      visionSessionId: session.id,
    }),
  };
}

export interface VisionSessionSummary {
  id: string;
  imageCount: number;
  labels: string[];
  questionsAnswered: number;
  cachedAnswers: number;
  reReads: number;
  ageMs: number;
}

function summarize(s: VisionSession): VisionSessionSummary {
  return {
    id: s.id,
    imageCount: s.images.length,
    labels: s.images.map((i) => i.label),
    // The opening observation is not a "question answered".
    questionsAnswered: Math.max(0, Math.floor(s.transcript.length / 2) - 1),
    cachedAnswers: s.cachedAnswers,
    reReads: s.reReads,
    ageMs: Date.now() - s.openedAt,
  };
}

/** The main agent is done with the images — free the bytes. */
export function closeVisionSession(visionSessionId: string): VisionSessionSummary | null {
  const s = sessions.get(visionSessionId);
  if (!s) return null;
  sessions.delete(visionSessionId);
  return summarize(s);
}

/** Close every open session (turn teardown / session switch). */
export function closeAllVisionSessions(): number {
  const n = sessions.size;
  sessions.clear();
  return n;
}

export function listVisionSessions(): VisionSessionSummary[] {
  sweep();
  return [...sessions.values()].map(summarize);
}

/** Most recently used open session — the default target for a bare follow-up. */
export function mostRecentVisionSessionId(): string | null {
  sweep();
  let bestId: string | null = null;
  let bestAt = -1;
  for (const [id, s] of sessions) {
    if (s.lastUsedAt > bestAt) {
      bestAt = s.lastUsedAt;
      bestId = id;
    }
  }
  return bestId;
}

/** Test seam. */
export function __resetVisionSessions(): void {
  sessions.clear();
}
