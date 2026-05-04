import type { ClassifierResult } from "../types.js";

const PATTERNS: Array<{
  re: RegExp;
  intent: string;
  confidence: number;
  tierHint: "fast" | "balanced" | "premium";
}> = [
  // English patterns
  { re: /\b(create|new|make|generate)\s+(a\s+)?(file|component|module|class|function)\b/i, intent: "create-file", confidence: 0.85, tierHint: "fast" },
  { re: /\b(edit|modify|update|change|fix|patch)\s+(the\s+)?\S+/i, intent: "edit", confidence: 0.8, tierHint: "fast" },
  { re: /\b(run|execute|exec)\s+(the\s+)?(command|script|npm|bun|tsc|test|build)\b/i, intent: "run-command", confidence: 0.85, tierHint: "fast" },
  { re: /\b(explain|what\s+does|describe|how\s+does)\b/i, intent: "explain", confidence: 0.7, tierHint: "fast" },
  { re: /\b(search|find|grep|look\s+for)\b/i, intent: "search", confidence: 0.8, tierHint: "fast" },
  { re: /\b(install|add)\s+(package|dep|dependency|module)\b/i, intent: "install", confidence: 0.85, tierHint: "fast" },
  { re: /\b(list|show|ls|cat|read|head|tail)\b/i, intent: "read", confidence: 0.8, tierHint: "fast" },
  { re: /\bgit\s+(status|log|diff|add|commit|push|pull|branch|checkout)\b/i, intent: "git", confidence: 0.85, tierHint: "fast" },
  { re: /\brefactor\b/i, intent: "refactor", confidence: 0.75, tierHint: "balanced" },
  { re: /\b(architect|design|plan|strategy)\b/i, intent: "design", confidence: 0.7, tierHint: "premium" },
  // Vietnamese patterns — higher tiers first to avoid premature fast-match
  { re: /(thiết kế|kiến trúc|architect|design|xây dựng hệ thống|chiến lược)/i, intent: "design", confidence: 0.7, tierHint: "premium" },
  { re: /(tái cấu trúc|refactor|cấu trúc lại|tổ chức lại)/i, intent: "refactor", confidence: 0.75, tierHint: "balanced" },
  { re: /(thêm tính năng|thêm chức năng|bổ sung|implement)/i, intent: "add-feature", confidence: 0.75, tierHint: "balanced" },
  { re: /(tạo|tạo mới|sinh|generate)\s+.*(file|component|module|class|hàm|function)/i, intent: "create-file", confidence: 0.85, tierHint: "fast" },
  { re: /(sửa|fix|chỉnh|update|cập nhật|patch|sửa lỗi)\s+\S+/i, intent: "edit", confidence: 0.8, tierHint: "fast" },
  { re: /(chạy|run|thực thi)\s+(lệnh|command|script|test|build)/i, intent: "run-command", confidence: 0.85, tierHint: "fast" },
  { re: /(giải thích|explain|mô tả|describe)\s+/i, intent: "explain", confidence: 0.7, tierHint: "fast" },
  { re: /(tìm|tìm kiếm|search|grep)\s+/i, intent: "search", confidence: 0.8, tierHint: "fast" },
  { re: /(cài|cài đặt|install|thêm)\s+(package|gói|thư viện|dep)/i, intent: "install", confidence: 0.85, tierHint: "fast" },
  { re: /(liệt kê|hiển thị|show|đọc|xem)\s+(file|thư mục|danh sách)/i, intent: "read", confidence: 0.8, tierHint: "fast" },
];

export function matchRegex(prompt: string): ClassifierResult {
  // Hot-path: catch obvious English CLI commands without brain call
  for (const p of PATTERNS) {
    if (p.re.test(prompt)) {
      return {
        tier: "hot",
        confidence: p.confidence,
        reason: `regex:${p.intent}`,
        tierHint: p.tierHint,
      };
    }
  }

  // Short messages in any language — delegate tier choice to brain via warm path
  // but mark as "hot" so we skip the cold path (expensive LLM)
  const trimmed = prompt.trim();
  if (trimmed.length <= 80 && trimmed.split(/\s+/).length <= 10) {
    return { tier: "hot", confidence: 0.6, reason: "regex:short-message", tierHint: "fast" };
  }

  return { tier: "abstain", confidence: 0.0, reason: "regex:no-match" };
}
