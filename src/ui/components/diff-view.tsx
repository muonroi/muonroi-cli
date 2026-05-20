import type { FileDiff } from "../../types/index";
import { detectLang, type Lang, tokenize } from "../syntax-highlight.js";
import type { Theme } from "../theme.js";

/* ── Diff View ────────────────────────────────────────────────── */

export type DiffRow =
  | { kind: "context"; oldNum: number; newNum: number; text: string }
  | { kind: "added"; newNum: number; text: string }
  | { kind: "removed"; oldNum: number; text: string }
  | { kind: "separator"; count: number };

const MAX_DIFF_ROWS = 20;
const LINE_NUM_WIDTH = 4;

export function parsePatch(patch: string): DiffRow[] {
  const lines = patch.split("\n");
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let prevOldEnd = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      const skipped = oldLine - prevOldEnd - 1;
      if (skipped > 0) {
        rows.push({ kind: "separator", count: skipped });
      }
      continue;
    }

    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\")) continue;
    if (line.startsWith("Index:") || line.startsWith("====")) continue;

    if (line.startsWith("-")) {
      rows.push({ kind: "removed", oldNum: oldLine, text: line.slice(1) });
      oldLine++;
      prevOldEnd = oldLine - 1;
    } else if (line.startsWith("+")) {
      rows.push({ kind: "added", newNum: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.length > 0 || (oldLine > 0 && newLine > 0)) {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "context", oldNum: oldLine, newNum: newLine, text: content });
      oldLine++;
      newLine++;
      prevOldEnd = oldLine - 1;
    }
  }

  return rows;
}

export function renderHighlighted(text: string, lang: Lang, t: Theme, fallback: string) {
  if (lang === "plain" || text.length === 0) {
    return <span style={{ fg: fallback }}>{text}</span>;
  }
  const tokens = tokenize(text, lang, t);
  if (tokens.length === 0) return <span style={{ fg: fallback }}>{text}</span>;
  return (
    <>
      {tokens.map((tok, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: token positions are stable per render
        <span key={`tk-${i}`} style={{ fg: tok.fg }}>
          {tok.text}
        </span>
      ))}
    </>
  );
}

export function DiffView({ t, diff }: { t: Theme; diff: FileDiff }) {
  const rows = parsePatch(diff.patch);
  if (rows.length === 0) return null;

  const truncated = rows.length > MAX_DIFF_ROWS;
  const visible = truncated ? rows.slice(0, MAX_DIFF_ROWS) : rows;
  const lang = detectLang(diff.filePath);

  const pad = (n: number | undefined) =>
    n !== undefined ? String(n).padStart(LINE_NUM_WIDTH) : " ".repeat(LINE_NUM_WIDTH);

  return (
    <box paddingLeft={5} marginTop={0} flexShrink={0}>
      <box flexDirection="column">
        {/* Header */}
        <box backgroundColor={t.diffHeader} paddingLeft={1} paddingRight={1}>
          <text>
            <span style={{ fg: t.diffHeaderFg }}>{diff.filePath}</span>
            <span style={{ fg: t.textDim }}>{"  "}</span>
            <span style={{ fg: t.diffRemovedFg }}>{`-${diff.removals}`}</span>
            <span style={{ fg: t.textDim }}> </span>
            <span style={{ fg: t.diffAddedFg }}>{`+${diff.additions}`}</span>
          </text>
        </box>

        {/* Rows */}
        {visible.map((row, i) => {
          if (row.kind === "separator") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: separator rows lack unique identifiers
              <box key={`sep-${i}`} backgroundColor={t.diffSeparator} paddingLeft={1}>
                <text fg={t.diffSeparatorFg}>
                  {"⌃  "}
                  {row.count}
                  {" unmodified lines"}
                </text>
              </box>
            );
          }
          if (row.kind === "removed") {
            return (
              <box key={`rm-${row.oldNum}`} backgroundColor={t.diffRemoved} flexDirection="row">
                <text fg={t.diffRemovedLineNum}>{pad(row.oldNum)}</text>
                <text>
                  <span style={{ fg: t.diffRemovedFg }}> </span>
                  {renderHighlighted(row.text, lang, t, t.diffRemovedFg)}
                </text>
              </box>
            );
          }
          if (row.kind === "added") {
            return (
              <box key={`add-${row.newNum}`} backgroundColor={t.diffAdded} flexDirection="row">
                <text fg={t.diffAddedLineNum}>{pad(row.newNum)}</text>
                <text>
                  <span style={{ fg: t.diffAddedFg }}> </span>
                  {renderHighlighted(row.text, lang, t, t.diffAddedFg)}
                </text>
              </box>
            );
          }
          return (
            <box key={`ctx-${row.oldNum}`} backgroundColor={t.diffContext} flexDirection="row">
              <text fg={t.diffLineNumber}>{pad(row.oldNum)}</text>
              <text>
                <span style={{ fg: t.diffContextFg }}> </span>
                {renderHighlighted(row.text, lang, t, t.diffContextFg)}
              </text>
            </box>
          );
        })}

        {truncated && (
          <box backgroundColor={t.diffSeparator} paddingLeft={1}>
            <text fg={t.diffSeparatorFg}>
              {"⌃  "}
              {rows.length - MAX_DIFF_ROWS}
              {" more lines"}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}

const MAX_READ_PREVIEW_LINES = 10;
const READ_LINE_NUM_WIDTH = 4;

export function ReadFilePreviewView({ t, filePath, content }: { t: Theme; filePath: string; content: string }) {
  const body = (content ?? "").trimEnd();
  if (!body) return null;
  if (body.startsWith("File not found:") || body.startsWith("Failed to read file:")) {
    return (
      <box paddingLeft={5} marginTop={0} flexShrink={0}>
        <text fg={t.diffRemovedFg}>{body}</text>
      </box>
    );
  }

  const allLines = body.split("\n");
  let header = "";
  let codeLines = allLines;
  if (allLines[0]?.startsWith("[") && allLines[0].endsWith("]")) {
    header = allLines[0].slice(1, -1);
    codeLines = allLines.slice(1);
  }

  const truncated = codeLines.length > MAX_READ_PREVIEW_LINES;
  const visible = truncated ? codeLines.slice(0, MAX_READ_PREVIEW_LINES) : codeLines;
  const lang = detectLang(filePath);

  const parsed = visible.map((raw) => {
    const m = /^(\s*\d+)\s\|\s(.*)$/.exec(raw);
    if (m) return { num: m[1].trimStart(), text: m[2] };
    return { num: "", text: raw };
  });

  const padNum = (s: string) => s.padStart(READ_LINE_NUM_WIDTH);

  return (
    <box paddingLeft={5} marginTop={0} flexShrink={0}>
      <box flexDirection="column">
        {header && (
          <box backgroundColor={t.diffHeader} paddingLeft={1} paddingRight={1}>
            <text fg={t.diffHeaderFg}>{header}</text>
          </box>
        )}
        <box backgroundColor={t.mdCodeBlockBg} paddingLeft={1} paddingRight={1} flexDirection="column">
          {parsed.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: read preview rows are positional
            <text key={`rd-${i}`}>
              <span style={{ fg: t.diffLineNumber }}>{padNum(row.num)}</span>
              <span style={{ fg: t.mdCodeBlockFg }}>{"  "}</span>
              {renderHighlighted(row.text, lang, t, t.mdCodeBlockFg)}
            </text>
          ))}
        </box>
        {truncated && (
          <box backgroundColor={t.diffSeparator} paddingLeft={1}>
            <text fg={t.diffSeparatorFg}>
              {"⌃  "}
              {codeLines.length - MAX_READ_PREVIEW_LINES}
              {" more lines"}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}
