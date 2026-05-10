/**
 * src/pil/layer1-intent.ts
 *
 * Layer 1: Intent detection.
 * Pass 1 — classifier (regex + tree-sitter): maps all 14 possible reason strings to TaskType.
 * Pass 2 — keyword fallback: catches debug/plan/documentation that classifier misses.
 * Pass 3 — EE brain fallback via bridge.classifyViaBrain (replaces ollamaClassify).
 * Populates taskType, confidence, and domain on PipelineContext.
 * outputStyle is always null from Layer 1 — Layer 6 handles output style detection via bridge.
 * Fail-open: any error returns ctx unchanged with applied=false.
 */

import { classify } from "../router/classifier/index.js";
import { classifyViaBrain } from "../ee/bridge.js";
import type { OutputStyle, PipelineContext, TaskType } from "./types.js";

// Maps every classifier reason string to a TaskType (or null for non-coding signals).
const REASON_TO_TASK_TYPE: Partial<Record<string, TaskType>> = {
  "regex:refactor": "refactor",
  "regex:edit": "generate",
  "regex:create-file": "generate",
  "regex:run-command": "analyze",
  "regex:explain": "analyze",
  "regex:search": "analyze",
  "regex:install": "analyze",
  "tree-sitter:typescript": "refactor",
  "tree-sitter:python": "refactor",
  "regex:read": "analyze",
  "regex:git": "analyze",
  "regex:short-message": "general",
  "regex:design": "plan",
  "regex:debug": "debug",
  // no-match / error / cold / low-confidence → null (conversational passthrough)
  "regex:no-match": undefined,
  "tree-sitter:no-fenced-code": undefined,
  "tree-sitter:cold": undefined,
  "tree-sitter:typescript-parse-error": undefined,
  "tree-sitter:python-parse-error": undefined,
  "low-confidence": undefined,
};

// Keyword patterns for task types the classifier doesn't natively handle.
// Applied when classifier abstains OR matches the low-signal "general" path.
// Patterns are bilingual (EN + VN) — Vietnamese cues use accent-insensitive
// alternations so common diacritic drops still match.
const KEYWORD_PATTERNS: Array<{ pattern: RegExp; taskType: TaskType; confidence: number }> = [
  {
    // EN: fix/bug/error/etc.  VN: sửa lỗi, lỗi, hỏng, không chạy
    pattern: /\b(fix|bug|error|exception|crash|fail(?:s|ed|ing)?|broken|wrong|issue|traceback)\b|(sửa lỗi|sua loi|báo lỗi|bao loi|\blỗi\b|\bloi\b|hỏng|hong|không chạy|khong chay)/i,
    taskType: "debug",
    confidence: 0.65,
  },
  {
    // EN: plan/roadmap/architecture.  VN: kế hoạch, thiết kế, kiến trúc, lộ trình
    pattern: /\b(plan|roadmap|phase|step(?:s)?|approach|design|architect(?:ure)?|strategy)\b|(kế hoạch|ke hoach|thiết kế|thiet ke|kiến trúc|kien truc|lộ trình|lo trinh)/i,
    taskType: "plan",
    confidence: 0.6,
  },
  {
    // EN: docs/readme/jsdoc.  VN: tài liệu, viết doc, ghi chú, comment
    pattern: /\b(doc(?:s|umentation)?|readme|comment|jsdoc|tsdoc|docstring)\b|(tài liệu|tai lieu|viết doc|viet doc|ghi chú|ghi chu)/i,
    taskType: "documentation",
    confidence: 0.6,
  },
  {
    // EN: test/spec/coverage.  VN: kiểm thử, viết test, kiểm tra
    pattern: /\b(test(?:s|ing)?|spec|unit test|coverage|assert(?:ion)?)\b|(kiểm thử|kiem thu|viết test|viet test|kiểm tra|kiem tra)/i,
    taskType: "analyze",
    confidence: 0.65,
  },
  {
    // EN: refactor.  VN: tái cấu trúc, viết lại, tổ chức lại
    pattern: /\brefactor(?:ing)?\b|(tái cấu trúc|tai cau truc|viết lại|viet lai|tổ chức lại|to chuc lai)/i,
    taskType: "refactor",
    confidence: 0.7,
  },
  {
    // EN: create/generate.  VN: tạo, sinh, viết mới
    pattern: /\b(generate|scaffold|bootstrap)\b|(tạo file|tao file|tạo module|tao module|sinh code|viết mới|viet moi)/i,
    taskType: "generate",
    confidence: 0.65,
  },
];

// Valid task types for bridge classification parsing (matches RESPONSE_SCHEMAS keys minus 'general').
const VALID_TASK_TYPES: TaskType[] = ["refactor", "debug", "plan", "analyze", "documentation", "generate"];

const VALID_STYLES = ["concise", "balanced", "detailed"] as const;

// Detect language/domain from prompt content. Order matters: code fences first
// (highest signal), file extensions next, then bare keywords.
const DOMAIN_PATTERNS: Array<{ pattern: RegExp; domain: string }> = [
  { pattern: /```(?:ts|tsx|typescript)\b/i, domain: "typescript" },
  { pattern: /```(?:js|jsx|javascript)\b/i, domain: "javascript" },
  { pattern: /```(?:py|python)\b/i, domain: "python" },
  { pattern: /```(?:rs|rust)\b/i, domain: "rust" },
  { pattern: /```(?:go|golang)\b/i, domain: "go" },
  { pattern: /```(?:java)\b/i, domain: "java" },
  { pattern: /```(?:cs|csharp)\b/i, domain: "csharp" },
  { pattern: /```(?:rb|ruby)\b/i, domain: "ruby" },
  { pattern: /\.(tsx?)\b/i, domain: "typescript" },
  { pattern: /\.(jsx?)\b/i, domain: "javascript" },
  { pattern: /\.py\b/i, domain: "python" },
  { pattern: /\.rs\b/i, domain: "rust" },
  { pattern: /\.go\b/i, domain: "go" },
  { pattern: /\.java\b/i, domain: "java" },
  { pattern: /\.cs\b/i, domain: "csharp" },
  { pattern: /\.rb\b/i, domain: "ruby" },
  { pattern: /\b(typescript|tsconfig|tsc)\b/i, domain: "typescript" },
  { pattern: /\b(python|pip|venv|django|flask)\b/i, domain: "python" },
  { pattern: /\b(rust|cargo)\b/i, domain: "rust" },
  { pattern: /\b(golang)\b/i, domain: "go" },
];

function extractDomain(reason: string, raw: string): string | null {
  // Tree-sitter signals are highest-confidence (the parser actually understood the code).
  if (reason.includes("typescript")) return "typescript";
  if (reason.includes("python")) return "python";
  // Fall back to raw-prompt scan so regex-classified turns still get domain.
  for (const { pattern, domain } of DOMAIN_PATTERNS) {
    if (pattern.test(raw)) return domain;
  }
  return null;
}

// Regex-based outputStyle detection — catches explicit user requests in EN/VN
// before we ever ask the brain. Order: most-specific first.
const STYLE_PATTERNS: Array<{ pattern: RegExp; style: OutputStyle }> = [
  { pattern: /\b(concise|brief|terse|short answer|tl;?dr|một câu|ngắn gọn|vắn tắt|tóm tắt)\b/i, style: "concise" },
  { pattern: /\b(detailed|thorough|in depth|step by step|walk me through|chi tiết|cặn kẽ|đầy đủ|từng bước)\b/i, style: "detailed" },
  { pattern: /\b(balanced|normal|standard|cân bằng|bình thường)\b/i, style: "balanced" },
];

function detectStyleFromText(raw: string): OutputStyle | null {
  for (const { pattern, style } of STYLE_PATTERNS) {
    if (pattern.test(raw)) return style;
  }
  return null;
}

export async function layer1Intent(ctx: PipelineContext): Promise<PipelineContext> {
  try {
    // Pass 1: classifier
    const result = classify(ctx.raw);
    let taskType: TaskType | null = REASON_TO_TASK_TYPE[result.reason] ?? null;
    let confidence = result.confidence;
    const domain = extractDomain(result.reason, ctx.raw);

    // Pass 2: keyword fallback. Runs when classifier abstains OR when the
    // classifier match was a low-signal "general" (regex:short-message), so
    // explicit doc/test/debug/plan keywords still win over the small-talk path.
    const lowSignal = taskType === "general" && result.reason === "regex:short-message";
    if (taskType === null || lowSignal) {
      for (const { pattern, taskType: kwType, confidence: kwConf } of KEYWORD_PATTERNS) {
        if (pattern.test(ctx.raw)) {
          taskType = kwType;
          confidence = kwConf;
          break;
        }
      }
    }

    // Pass 3a: EE brain — single call to classify both taskType and style.
    // Bumped from 100/50ms to 1500/800ms because brain LLM realistic latency
    // is ~700-2000ms (SiliconFlow Qwen3-14B via VPS proxy). Pipeline timeout
    // is 3000ms in brain mode (see pipeline.ts), so this fits within budget.
    //
    // Bilingual prompt: explicit EN + VN cues so the brain doesn't reflexively
    // tag VN coding requests as "none" (a regression we hit when prompts like
    // "tôi muốn debug …" or "sửa lỗi …" went through).
    let outputStyle: OutputStyle | null = null;
    // Hot-path short-circuit: ultra-short greetings ("hi", "ok", "thanks", "ty")
    // get mapped to taskType="general" without burning a brain round-trip.
    // Both conditions required (AND) so we don't accidentally swallow phrases
    // like "refactor this" or "fix the bug" that happen to be short.
    const trimmed = ctx.raw.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    // Hot-path fires when there's NO task signal AND the input is ultra-short.
    // Pass 1 (classifier) tags short messages as taskType="general" via
    // `regex:short-message`. If Pass 2 keyword fallback found nothing either,
    // we treat that as chitchat too — otherwise "hi" would be classified as
    // "general task" instead of "chitchat" and lose the MCP-skip optimization.
    const noTaskSignal =
      taskType === null ||
      (taskType === "general" && result.reason === "regex:short-message");
    const isHotPathChitchat = noTaskSignal && trimmed.length < 10 && wordCount <= 2;
    let intentKind: "task" | "chitchat" | null = null;
    if (isHotPathChitchat) {
      taskType = "general";
      confidence = 0.5;
      intentKind = "chitchat";
      // Greetings get a concise default — no need to spend 800ms on a brain
      // round-trip in Pass 3b just to learn the user wants a short reply.
      outputStyle = "concise";
    }

    if (taskType === null) {
      const brainRaw = await classifyViaBrain(
        `You are a multilingual prompt classifier. The user's prompt may be in English, Vietnamese, or a mix of both.
Classify the prompt's INTENT (not its language). Reply with TWO lowercase words separated by a comma: <category>,<style>

Category — pick ONE:
  refactor      — restructure existing code (tái cấu trúc, refactor)
  debug         — fix a bug or investigate failure (sửa lỗi, fix bug, lỗi, traceback)
  plan          — design / roadmap / architecture (kế hoạch, thiết kế, kiến trúc)
  analyze       — explain / inspect / review code (giải thích, phân tích, review)
  documentation — write docs/comments (viết docs, comment, jsdoc)
  generate      — create new code/file (tạo, sinh code, viết function mới)
  none          — pure chitchat with NO coding intent

Style — pick ONE:
  concise (ngắn gọn) | balanced (cân bằng) | detailed (chi tiết)

Examples:
  "Refactor this function" → refactor,balanced
  "tại sao test fail" → debug,balanced
  "thiết kế hệ thống auth" → plan,detailed
  "hi" → none,concise

Prompt: "${ctx.raw.slice(0, 500)}"`,
        1500,
      );
      if (brainRaw) {
        const lower = brainRaw.toLowerCase();
        const matched = VALID_TASK_TYPES.find(t => lower.includes(t));
        if (matched) {
          taskType = matched;
          confidence = 0.55;
          intentKind = "task";
        } else if (/\bnone\b/.test(lower)) {
          // Brain explicitly classified as chitchat / no-coding-intent.
          taskType = "general";
          confidence = 0.6;
          intentKind = "chitchat";
          if (outputStyle === null) outputStyle = "concise";
        }
        const styleMatched = VALID_STYLES.find(s => lower.includes(s));
        if (styleMatched) outputStyle = styleMatched;
      }
    }

    // Pass 3b: brain-only style detection when classifier already gave us a taskType.
    if (outputStyle === null && taskType !== null) {
      const brainRaw = await classifyViaBrain(
        `Detect the user's preferred output style. The prompt may be EN or VN.
Reply with ONE word: concise (ngắn gọn) | balanced (bình thường) | detailed (chi tiết).

Prompt: "${ctx.raw.slice(0, 300)}"`,
        800,
      );
      if (brainRaw) {
        const styleMatched = VALID_STYLES.find(s => brainRaw.toLowerCase().includes(s));
        if (styleMatched) outputStyle = styleMatched;
      }
    }

    // Pass 4 (safety net): regex-based style detection. Only fires when the
    // brain returned nothing (timeout / EE disabled). Keeps explicit user
    // requests like "ngắn gọn" / "concise" working even without brain.
    if (outputStyle === null) {
      outputStyle = detectStyleFromText(ctx.raw);
    }

    if (intentKind === null && taskType !== null && taskType !== "general") {
      intentKind = "task";
    }

    return {
      ...ctx,
      taskType,
      domain,
      confidence,
      outputStyle,
      intentKind,
      layers: [
        ...ctx.layers,
        {
          name: "intent-detection",
          applied: taskType !== null,
          delta:
            taskType !== null
              ? `taskType=${taskType},kind=${intentKind ?? "unknown"},conf=${confidence.toFixed(2)},domain=${domain ?? "none"},style=${outputStyle ?? "none"}`
              : null,
        },
      ],
    };
  } catch {
    return {
      ...ctx,
      layers: [...ctx.layers, { name: "intent-detection", applied: false, delta: null }],
    };
  }
}
