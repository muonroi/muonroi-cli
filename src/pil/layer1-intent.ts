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

import { classifyViaBrain, pilContext } from "../ee/bridge.js";
import { classify } from "../router/classifier/index.js";
import { isUnifiedPilEnabled } from "./config.js";
import type { BrainData, IntentDetectionTrace, OutputStyle, PipelineContext, TaskType } from "./types.js";

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
    pattern:
      /\b(fix|bug|error|exception|crash|fail(?:s|ed|ing)?|broken|wrong|issue|traceback)\b|(sửa lỗi|sua loi|báo lỗi|bao loi|\blỗi\b|\bloi\b|hỏng|hong|không chạy|khong chay)/i,
    taskType: "debug",
    confidence: 0.65,
  },
  {
    // EN: plan/roadmap/architecture.  VN: kế hoạch, thiết kế, kiến trúc, lộ trình
    pattern:
      /\b(plan|roadmap|phase|step(?:s)?|approach|design|architect(?:ure)?|strategy)\b|(kế hoạch|ke hoach|thiết kế|thiet ke|kiến trúc|kien truc|lộ trình|lo trinh)/i,
    taskType: "plan",
    confidence: 0.6,
  },
  {
    // EN: docs/readme/jsdoc.  VN: tài liệu, viết doc, ghi chú, comment
    pattern:
      /\b(doc(?:s|umentation)?|readme|comment|jsdoc|tsdoc|docstring)\b|(tài liệu|tai lieu|viết doc|viet doc|ghi chú|ghi chu)/i,
    taskType: "documentation",
    confidence: 0.6,
  },
  {
    // EN: test/spec/coverage.  VN: kiểm thử, viết test, kiểm tra
    pattern:
      /\b(test(?:s|ing)?|spec|unit test|coverage|assert(?:ion)?)\b|(kiểm thử|kiem thu|viết test|viet test|kiểm tra|kiem tra)/i,
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
  {
    pattern: /\b(detailed|thorough|in depth|step by step|walk me through|chi tiết|cặn kẽ|đầy đủ|từng bước)\b/i,
    style: "detailed",
  },
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
    // Pass 1: local classifier.
    const result = classify(ctx.raw);
    const pass1TaskType: TaskType | null = REASON_TO_TASK_TYPE[result.reason] ?? null;
    let taskType: TaskType | null = pass1TaskType;
    let confidence = result.confidence;
    const domain = extractDomain(result.reason, ctx.raw);
    let outputStyle: OutputStyle | null = null;
    let intentKind: "task" | "chitchat" | null = null;
    let brainData: BrainData | null = null;
    // Step-by-step trace — populated as each pass runs so cost reports can
    // attribute which pass actually decided the outcome.
    let pass2Pattern: string | undefined;
    let pass2Hit = false;
    let pass25ChitchatHit = false;
    let pass3UnifiedSucceeded = false;
    let pass3LegacyTaskAttempted = false;
    let pass3LegacyTaskSucceeded = false;
    let pass3LegacyStyleAttempted = false;
    let pass3LegacyStyleSucceeded = false;
    let styleSource: IntentDetectionTrace["styleSource"] = "none";

    // Pass 2: keyword fallback. Runs when classifier abstains OR when the
    // classifier match was a low-signal "general" (regex:short-message).
    const lowSignal = taskType === "general" && result.reason === "regex:short-message";
    if (taskType === null || lowSignal) {
      for (const { pattern, taskType: kwType, confidence: kwConf } of KEYWORD_PATTERNS) {
        if (pattern.test(ctx.raw)) {
          taskType = kwType;
          confidence = kwConf;
          pass2Hit = true;
          pass2Pattern = pattern.source;
          break;
        }
      }
    }

    // Pass 2.5: hot-path chitchat short-circuit for ultra-short greetings
    // ("hi", "ok", "thanks", "ty") — mapped to taskType="general" without
    // burning a brain round-trip. Both conditions required (AND) so we don't
    // accidentally swallow phrases like "refactor this" or "fix the bug" that
    // happen to be short.
    //
    // TODO(WhoAmI-Pass0): when EE v4.0 Who Am I profile is available, read
    // communication.brevity + decision_speed here as outputStyle baseline.
    const trimmed = ctx.raw.trim();
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const noTaskSignal = taskType === null || (taskType === "general" && result.reason === "regex:short-message");
    if (noTaskSignal && trimmed.length < 10 && wordCount <= 2) {
      taskType = "general";
      confidence = 0.5;
      intentKind = "chitchat";
      outputStyle = "concise";
      pass25ChitchatHit = true;
      styleSource = "chitchat-default";
    }

    // Pass 3 UNIFIED: single /api/pil-context call replaces the multi-call
    // cascade (classifier rescue + style brain). Fires only when flag is on
    // AND local signal is weak (no taskType or low confidence) AND we haven't
    // already short-circuited to chitchat.
    const HIGH_CONF_THRESHOLD = 0.7;
    const needsBrain =
      isUnifiedPilEnabled() && intentKind !== "chitchat" && (taskType === null || confidence < HIGH_CONF_THRESHOLD);

    let unifiedFailed = false;
    if (needsBrain) {
      const resp = await pilContext(ctx.raw, {
        projectCtx: domain ? { domain } : undefined,
        budgetMs: 1500,
      });
      if (resp) {
        if (resp.taskType) taskType = resp.taskType;
        if (resp.intentKind) intentKind = resp.intentKind;
        if (resp.outputStyle) {
          outputStyle = resp.outputStyle;
          styleSource = "brain-unified";
        }
        if (resp.confidence) confidence = resp.confidence;
        brainData = {
          t0_principles: resp.t0_principles,
          t1_rules: resp.t1_rules,
          t2_patterns: resp.t2_patterns,
          retrieval_skipped_reason: resp.retrieval_skipped_reason,
        };
        pass3UnifiedSucceeded = true;
      } else {
        unifiedFailed = true;
      }
    }

    // Pass 3 LEGACY FALLBACK: only runs when flag off.
    // Cost optimization: when unified call FAILED, we skip the legacy brain
    // round-trips entirely. The unified pilContext already tried the same
    // backend; a second classifyViaBrain ~1.5s after a failure almost always
    // fails too, wasting tokens and ~2.3s of wall time. The cheap regex style
    // detector still runs below to recover explicit "ngắn gọn"/"detailed" cues.
    const runLegacyBrain = !isUnifiedPilEnabled();
    let legacyBrainAttempted = false;
    if (runLegacyBrain) {
      if (taskType === null) {
        legacyBrainAttempted = true;
        pass3LegacyTaskAttempted = true;
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
          pass3LegacyTaskSucceeded = true;
          const lower = brainRaw.toLowerCase();
          const matched = VALID_TASK_TYPES.find((t) => lower.includes(t));
          if (matched) {
            taskType = matched;
            confidence = 0.55;
            intentKind = "task";
          } else if (/\bnone\b/.test(lower)) {
            taskType = "general";
            confidence = 0.6;
            intentKind = "chitchat";
            if (outputStyle === null) {
              outputStyle = "concise";
              styleSource = "chitchat-default";
            }
          }
          const styleMatched = VALID_STYLES.find((s) => lower.includes(s));
          if (styleMatched) {
            outputStyle = styleMatched;
            styleSource = "brain-legacy";
          }
        }
      }

      // Pass 3b legacy: brain-only style detection when classifier gave a
      // taskType AND regex found no explicit style signal. Regex Pass 3.5 (below)
      // runs FIRST so explicit cues skip this 800ms call.
      if (outputStyle === null) {
        const regexStyle = detectStyleFromText(ctx.raw);
        if (regexStyle) {
          outputStyle = regexStyle;
          styleSource = "explicit-regex";
        }
      }

      if (outputStyle === null && taskType !== null) {
        legacyBrainAttempted = true;
        pass3LegacyStyleAttempted = true;
        const brainRawStyle = await classifyViaBrain(
          `Detect the user's preferred output style. The prompt may be EN or VN.
Reply with ONE word: concise (ngắn gọn) | balanced (bình thường) | detailed (chi tiết).

Prompt: "${ctx.raw.slice(0, 300)}"`,
          800,
        );
        if (brainRawStyle) {
          pass3LegacyStyleSucceeded = true;
          const styleMatched = VALID_STYLES.find((s) => brainRawStyle.toLowerCase().includes(s));
          if (styleMatched) {
            outputStyle = styleMatched;
            styleSource = "brain-legacy";
          }
        }
      }
    } else if (unifiedFailed && outputStyle === null) {
      // Cheap rescue path when unified PIL is enabled but its call failed:
      // run only the free regex style detector. The L6 brain-rescue call is
      // suppressed below by the `_brainData` sentinel so we don't repeat the
      // same network round-trip that just timed out.
      const regexStyle = detectStyleFromText(ctx.raw);
      if (regexStyle) {
        outputStyle = regexStyle;
        styleSource = "explicit-regex";
      }
    }

    if (intentKind === null && taskType !== null && taskType !== "general") {
      intentKind = "task";
    }

    // L6 brain-rescue suppression sentinel. L6 only checks truthiness of
    // _brainData to decide whether to spend another 50ms brain round-trip on
    // style detection. If we either (a) succeeded with unified pilContext,
    // (b) failed unified (network already down), or (c) attempted a legacy
    // brain call here, then L6 has nothing new to learn — set a sentinel.
    const brainDataOut: BrainData | null =
      brainData ??
      (unifiedFailed || legacyBrainAttempted
        ? {
            t0_principles: [],
            t1_rules: [],
            t2_patterns: [],
            retrieval_skipped_reason: unifiedFailed ? "unified-failed" : "legacy-attempted",
          }
        : null);

    // pass1Hit = Pass 1 alone decided the final outcome (no later pass overrode).
    // Note: chitchat short-circuit overrides Pass 1, so we exclude that case.
    const pass1Hit =
      pass1TaskType !== null &&
      taskType === pass1TaskType &&
      !pass2Hit &&
      !pass25ChitchatHit &&
      !pass3UnifiedSucceeded &&
      !pass3LegacyTaskSucceeded;

    const intentTrace: IntentDetectionTrace = {
      pass1Reason: result.reason,
      pass1Confidence: result.confidence,
      pass1TaskType,
      pass1Hit,
      pass2Hit,
      pass2Pattern,
      pass25ChitchatHit,
      pass3UnifiedAttempted: needsBrain,
      pass3UnifiedSucceeded,
      pass3LegacyTaskAttempted,
      pass3LegacyTaskSucceeded,
      pass3LegacyStyleAttempted,
      pass3LegacyStyleSucceeded,
      styleSource,
      finalTaskType: taskType,
      finalConfidence: confidence,
    };

    return {
      ...ctx,
      taskType,
      domain,
      confidence,
      outputStyle,
      intentKind,
      _brainData: brainDataOut,
      _intentTrace: intentTrace,
      layers: [
        ...ctx.layers,
        {
          name: "intent-detection",
          applied: taskType !== null,
          delta:
            taskType !== null
              ? `taskType=${taskType},kind=${intentKind ?? "unknown"},conf=${confidence.toFixed(2)},domain=${domain ?? "none"},style=${outputStyle ?? "none"},unified=${brainData ? "ok" : unifiedFailed ? "fail" : "skip"}`
              : unifiedFailed
                ? `taskType=null,unified=fail`
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
