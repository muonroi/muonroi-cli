/**
 * scripts/e2e-debate-real-prompt.ts
 *
 * Reproduce session a7a5690d2049's failure: all 4 Round-1 debate turns
 * returned empty after a fix that worked on smaller probes. This script
 * builds the EXACT prompt shape via buildResponsePrompt() with realistic
 * 5KB partner/own positions (mirroring the opening sizes seen in the
 * export) and runs llm.debate with the same maxOutputTokens=6144 setting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createCouncilLLM } from "../src/council/llm.js";
import { buildResponsePrompt, buildFollowupPrompt } from "../src/council/prompts.js";
import type { CouncilStats } from "../src/council/types.js";

const LOG_PATH = path.resolve("council-debug-realprompt.jsonl");
if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
process.env.MUONROI_COUNCIL_DEBUG_LOG = LOG_PATH;
console.log(`Debug log → ${LOG_PATH}`);

const FLASH = "deepseek-v4-flash";
const PRO = "deepseek-v4-pro";

const stats: CouncilStats = { calls: 0, startMs: Date.now(), phases: [] };
const noopBash = {} as unknown as Parameters<typeof createCouncilLLM>[0];
const llm = createCouncilLLM(noopBash, "default", "e2e-real-prompt", stats);

// Realistic 5KB opening — mirrors session a7a5690d2049 line 102-176 structure.
const ARCHITECT_OPENING = `## Feasibility of the Three Approaches

### 1. Injecting content scripts into PDF viewer pages
Browser PDF viewers (Chrome's built-in, Firefox PDF.js, Brave) render PDFs in iframes with restricted origins. Manifest V3 content scripts cannot inject into ${"chrome-extension://"} URLs by default. The PDF.js viewer in Brave runs at oemmndcbldboiebfnladdacbdfmadadm — content scripts targeting it require explicit web_accessible_resources and matches patterns that Chrome refuses to honor for built-in extensions. [CONFIRMED via Chrome docs: content scripts cannot match chrome-extension origins]

### 2. Using OCR on canvas
PDF.js renders pages to <canvas> elements. Capturing selection via canvas-rect → OCR (Tesseract.js) is a fallback but has 3 serious issues:
- Latency: 800-2000ms per word (vs 50ms for native text)
- Accuracy: degrades on non-Latin scripts, italics, ligatures
- Resource cost: WebAssembly OCR consumes 30-40MB heap per worker

### 3. Intercepting text selection events
The viable path: replace the default PDF viewer with our own PDF.js-based viewer at extension://OUR_ID/viewer.html, then content scripts work natively. The transition requires:
- declarativeNetRequest rules to redirect *.pdf URLs to our viewer
- Manifest V3 web_accessible_resources for viewer.html
- chrome.webRequest for file:// PDFs (extension needs file access permission)

## Recommended Architecture (High-Level)

1. **PDF Viewer Replacement** — Bundle PDF.js (v4.x) into the extension. Use declarativeNetRequest to redirect application/pdf navigations to viewer.html?file=<original_url>.
2. **Content Script** — In viewer.html, attach mouseup + selectionchange listeners. On selection, compute getBoundingClientRect, send to background.
3. **Translation Service Worker** — Receives selected text via chrome.runtime.sendMessage. Calls Google Cloud Translation API with API key from chrome.storage. Returns translated text.
4. **Tooltip UI** — Background sends back to content script, which renders an absolutely-positioned <div> over the selection.

## Open Questions for the Integration & UX Engineer

What's your view on tooltip placement when selection is near viewport edges? Should we use Popper.js or hand-roll the positioning? Also: what's the ideal debounce for selectionchange to avoid spamming the translation API while still feeling responsive?`;

const UX_OPENING = `## 1. Tooltip UI Placement Over Selected Text

The tooltip needs to anchor to the selection bounding box. I recommend Popper.js (or Floating-UI, its successor) with placement="top-start" and a fallback chain ["bottom-start", "top-end", "bottom-end"]. This handles 95% of edge cases. Hand-rolling costs 200+ LOC for marginal gain.

## 2. Debouncing API Calls

300ms debounce is the sweet spot from user studies. Below 200ms feels "twitchy" — the tooltip appears mid-selection drag. Above 500ms feels laggy. Implementation:
\`\`\`javascript
const debouncedTranslate = debounce(translate, 300);
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection().toString().trim();
  if (sel.length >= 2 && sel.length <= 500) debouncedTranslate(sel);
});
\`\`\`

## 3. Caching Translations

Use a two-tier cache:
- L1: in-memory Map<string, string>, max 200 entries, LRU eviction
- L2: chrome.storage.local, key = sha256(text + targetLang), TTL 7 days

Expected cache hit rate after 1 week of use: 35-50% for repeated text in academic PDFs.

## 4. Handling PDF Zoom Levels and Scroll Positions

PDF.js zoom changes element scale via CSS transform. The tooltip's getBoundingClientRect is in CSS pixels (post-transform), so positioning math is straightforward — just verify on zoom levels 50%, 100%, 200%. Scroll: tooltip should re-anchor on scroll using IntersectionObserver to hide when selection leaves viewport.

## 5. Making It Feel Native

- Subtle entry animation (opacity 0→1 over 150ms)
- Match user's system font + dark/light mode (prefers-color-scheme)
- ESC key dismisses
- Click outside to dismiss (capture phase, don't propagate)
- For long translations, add a "Copy" button — research shows users copy translations 40% of the time`;

const spec = {
  problemStatement: "Build a browser extension for Chrome/Brave that translates selected text in PDF files via an inline tooltip, using Google Translate or third-party APIs.",
  constraints: [],
  successCriteria: [
    "User can select text in any browser-rendered PDF and see a translation tooltip within 1 second",
    "Translation accuracy supports at least Vietnamese, English, Chinese, Japanese",
    "Tooltip doesn't disrupt normal PDF viewing/scrolling",
  ],
  scope: "Determined by conversation context",
} as const;

const r1 = buildResponsePrompt({
  speakerRole: "verify",
  partnerRole: "implement",
  speakerStance: { name: "Integration & UX Engineer", lens: "user experience and frontend integration", focus: "tooltip, debounce, cache" },
  partnerStance: { name: "Extension Architect", lens: "browser extension architecture", focus: "MV3, content scripts, PDF viewer" },
  speakerPosition: UX_OPENING,
  partnerPosition: ARCHITECT_OPENING,
  spec: spec as any,
});

console.log(`\nbuildResponsePrompt sizes: system=${r1.system.length} chars, prompt=${r1.prompt.length} chars, total=${r1.system.length + r1.prompt.length}`);

async function probe(label: string, model: string, system: string, prompt: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await llm.debate(model, system, prompt);
    console.log(`${label}: textChars=${res.text.length}, toolCalls=${res.toolCalls.length}, ms=${Date.now() - t0}`);
    console.log(`  head: ${res.text.slice(0, 200).replace(/\n/g, " ")}`);
  } catch (err) {
    console.log(`${label}: THREW: ${err instanceof Error ? err.message : err}`);
  }
}

async function main(): Promise<void> {
  console.log("\n== ROUND 1 — UX → Architect (Flash) ==");
  await probe("flash-r1", FLASH, r1.system, r1.prompt);

  console.log("\n== ROUND 1 — UX → Architect (Pro) ==");
  await probe("pro-r1", PRO, r1.system, r1.prompt);

  console.log("\n== Log dump ==");
  const lines = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n");
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      console.log(JSON.stringify({
        kind: r.kind, model: r.modelId, ok: r.ok,
        sysCh: r.systemChars, promptCh: r.promptChars,
        textCh: r.textChars, reasonCh: r.reasoningChars,
        finish: r.finishReason, ms: r.durationMs,
        usage: (r.usage as any)?.outputTokenDetails,
        error: r.error,
        textHead: r.textHead?.slice(0, 100),
      }));
    } catch { /* skip */ }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
