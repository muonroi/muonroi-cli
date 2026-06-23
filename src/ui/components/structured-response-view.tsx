import type { StructuredResponse } from "../../types/index";
import { renderMarkdown } from "../markdown-render.js";
import type { Theme } from "../theme.js";

export function StructuredResponseView({ t, sr, modeColor }: { t: Theme; sr: StructuredResponse; modeColor: string }) {
  const d = sr.data;
  switch (sr.taskType) {
    case "refactor": {
      const r = d as { summary?: string; changes?: Array<{ file: string; diff: string }>; verify_command?: string };
      return (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          <text>
            <span style={{ fg: modeColor }}>{"◆ "}</span>
            <span style={{ fg: "#ffffff" }}>{r.summary ?? "Refactor"}</span>
          </text>
          {(r.changes ?? []).map((c, i) => (
            <box key={`rc${i}`} flexDirection="column" marginTop={1}>
              <text>
                <span style={{ fg: t.accent }}>{"  ── "}</span>
                <span style={{ fg: t.accent }}>{c.file}</span>
                <span style={{ fg: t.accent }}>{" ──"}</span>
              </text>
              {c.diff.split("\n").map((line, j) => {
                const fg = line.startsWith("+") ? t.diffAddedFg : line.startsWith("-") ? t.diffRemovedFg : t.text;
                return <text key={`rl${i}-${j}`} fg={fg}>{`  ${line}`}</text>;
              })}
            </box>
          ))}
          {r.verify_command && <text fg={t.textMuted} marginTop={1}>{`  verify: ${r.verify_command}`}</text>}
        </box>
      );
    }
    case "debug": {
      const r = d as {
        hypothesis?: string;
        root_cause?: string;
        fix?: { file: string; diff: string };
        verify_command?: string;
      };
      return (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          <text>
            <span style={{ fg: modeColor }}>{"◆ "}</span>
            <span style={{ fg: t.textMuted }}>{"hypothesis: "}</span>
            <span>{r.hypothesis}</span>
          </text>
          <text>
            <span style={{ fg: t.textMuted }}>{"  root cause: "}</span>
            <span style={{ fg: "#ffffff" }}>{r.root_cause}</span>
          </text>
          {r.fix && (
            <box flexDirection="column" marginTop={1}>
              <text>
                <span style={{ fg: t.accent }}>{"  ── fix: "}</span>
                <span style={{ fg: t.accent }}>{r.fix.file}</span>
                <span style={{ fg: t.accent }}>{" ──"}</span>
              </text>
              {r.fix.diff.split("\n").map((line, j) => {
                const fg = line.startsWith("+") ? t.diffAddedFg : line.startsWith("-") ? t.diffRemovedFg : t.text;
                return <text key={`dl${j}`} fg={fg}>{`  ${line}`}</text>;
              })}
            </box>
          )}
          {r.verify_command && <text fg={t.textMuted} marginTop={1}>{`  verify: ${r.verify_command}`}</text>}
        </box>
      );
    }
    case "plan": {
      const r = d as {
        steps?: Array<{ action: string; criterion: string; rationale?: string }>;
        assumptions?: string[];
        risks?: string[];
      };
      return (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          {(r.steps ?? []).map((s, i) => (
            <box key={`ps${i}`} flexDirection="column">
              <text>
                <span style={{ fg: t.planStepNum }}>{`${i + 1}. `}</span>
                <span style={{ fg: "#ffffff" }}>{s.action}</span>
              </text>
              <text fg={t.planStepDesc}>{`   done when: ${s.criterion}`}</text>
              {s.rationale && <text fg={t.textMuted}>{`   why: ${s.rationale}`}</text>}
            </box>
          ))}
          {(r.assumptions?.length ?? 0) > 0 && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.textMuted}>{"  assumptions:"}</text>
              {r.assumptions!.map((a, i) => (
                <text key={`pa${i}`} fg={t.text}>{`    - ${a}`}</text>
              ))}
            </box>
          )}
          {(r.risks?.length ?? 0) > 0 && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.textMuted}>{"  risks:"}</text>
              {r.risks!.map((rk, i) => (
                <text key={`pr${i}`} fg={t.diffRemovedFg}>{`    - ${rk}`}</text>
              ))}
            </box>
          )}
        </box>
      );
    }
    case "analyze": {
      const r = d as { findings?: Array<{ text: string; evidence: string; severity: string }>; response?: string };
      // Graceful fallback: model may have called respond_analyze but sent a
      // free-form { response: "..." } payload (schema mismatch due to tool being
      // unavailable in the current turn). Render as plain markdown rather than
      // an empty findings list (session 48d22fe436f6 swallowed-answer bug).
      if ((!r.findings || r.findings.length === 0) && typeof r.response === "string" && r.response.trim()) {
        return (
          <box flexDirection="column" paddingLeft={2} marginTop={1}>
            {renderMarkdown(r.response, t)}
          </box>
        );
      }
      const sevColor = (s: string) => (s === "high" ? t.diffRemovedFg : s === "medium" ? t.planStepNum : t.textMuted);
      return (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          {(r.findings ?? []).map((f, i) => (
            <box key={`af${i}`} flexDirection="column">
              <text>
                <span style={{ fg: sevColor(f.severity) }}>{`[${f.severity.toUpperCase()}] `}</span>
                <span>{f.text}</span>
              </text>
              <text fg={t.textMuted}>{`  evidence: ${f.evidence}`}</text>
            </box>
          ))}
        </box>
      );
    }
    case "documentation": {
      const r = d as { content?: string; examples?: Array<{ code: string; description: string }> };
      return (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          {r.content ? renderMarkdown(r.content, t) : null}
          {(r.examples ?? []).map((ex, i) => (
            <box key={`de${i}`} flexDirection="column" marginTop={1}>
              <text fg={t.textMuted}>{ex.description}</text>
              <text fg={t.mdCode}>{ex.code}</text>
            </box>
          ))}
        </box>
      );
    }
    case "generate": {
      const r = d as { files?: Array<{ path: string; content: string; language: string }>; explanation?: string };
      return (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          {r.explanation && <text fg={t.textMuted}>{r.explanation}</text>}
          {(r.files ?? []).map((f, i) => (
            <box key={`gf${i}`} flexDirection="column" marginTop={1}>
              <text>
                <span style={{ fg: t.accent }}>{"── "}</span>
                <span style={{ fg: t.accent }}>{f.path}</span>
                <span style={{ fg: t.textMuted }}>{` (${f.language})`}</span>
                <span style={{ fg: t.accent }}>{" ──"}</span>
              </text>
              <text fg={t.mdCodeBlockFg}>{f.content}</text>
            </box>
          ))}
        </box>
      );
    }
    case "general": {
      // `reasoning` is the model's internal justification — deliberately NOT
      // surfaced (it leaked as a "── reasoning:" tail and reads as process
      // narration). The user-facing answer is `response`, rendered as markdown.
      const g = d as { response?: string; reasoning?: string };
      if (!g.response) return <text fg={t.textMuted}>{JSON.stringify(d, null, 2)}</text>;
      return (
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          {renderMarkdown(g.response, t)}
        </box>
      );
    }
    default: {
      // Graceful fallback for taskTypes without a dedicated renderer (e.g. a new
      // PIL schema added without UI updates). Probe for common text-bearing fields
      // before falling back to raw JSON.
      const obj = (d ?? {}) as Record<string, unknown>;
      const primary =
        (typeof obj.response === "string" && obj.response) ||
        (typeof obj.summary === "string" && obj.summary) ||
        (typeof obj.content === "string" && obj.content) ||
        (typeof obj.text === "string" && obj.text) ||
        null;
      if (primary) {
        return (
          <box flexDirection="column" paddingLeft={2} marginTop={1}>
            {renderMarkdown(primary, t)}
            <text fg={t.textMuted}>{`  ── (renderer missing for taskType: ${sr.taskType})`}</text>
          </box>
        );
      }
      return <text fg={t.text}>{JSON.stringify(d, null, 2)}</text>;
    }
  }
}
