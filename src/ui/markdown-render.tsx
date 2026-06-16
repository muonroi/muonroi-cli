/**
 * src/ui/markdown-render.tsx
 *
 * Self-contained markdown → styled-text renderer for the TUI.
 *
 * Why this exists: the bundled `@opentui/core` MarkdownRenderable (v0.1.107)
 * does NOT support concealing syntax markers — the `conceal` prop passed to
 * `<markdown>` is silently ignored, so `**bold**`, `### heading`, `` `code` ``
 * and `- bullet` all render with their literal markers visible (verified via
 * @opentui/react testRender). On top of that the tree-sitter wasm used for
 * highlight often fails to load, leaving raw unstyled text. The result reads
 * like machine output rather than a rendered answer.
 *
 * This renderer parses the common markdown constructs an LLM answer uses and
 * emits opentui `<text>`/`<span>` nodes with theme colors and the markers
 * stripped. It is intentionally pragmatic (not CommonMark-complete): headings,
 * bold, italic, bold+italic, inline code, strikethrough, links, ordered and
 * unordered lists, blockquotes, fenced code blocks, and horizontal rules.
 * Unterminated inline markers degrade to literal text (streaming-safe).
 */

import type { ReactNode } from "react";
import { detectLang, tokenize } from "./syntax-highlight.js";
import type { Theme } from "./theme.js";

export interface InlineSegment {
  text: string;
  fg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
}

// Inline markers, longest-first so `***` wins over `**`/`*` and `~~` is whole.
const INLINE = [
  { open: "***", close: "***", bold: true, italic: true },
  { open: "___", close: "___", bold: true, italic: true },
  { open: "**", close: "**", bold: true },
  { open: "__", close: "__", bold: true },
  { open: "~~", close: "~~", strike: true },
  { open: "*", close: "*", italic: true },
  { open: "_", close: "_", italic: true },
] as const;

function pushText(out: InlineSegment[], text: string, base: Partial<InlineSegment>) {
  if (!text) return;
  const last = out[out.length - 1];
  // Merge adjacent plain segments to keep the span count low.
  if (last && !last.fg && !last.bold && !last.italic && !last.underline && !last.strike && isPlain(base)) {
    last.text += text;
    return;
  }
  out.push({ text, ...base });
}

function isPlain(b: Partial<InlineSegment>): boolean {
  return !b.fg && !b.bold && !b.italic && !b.underline && !b.strike;
}

/**
 * Parse a single line of inline markdown into styled segments, with markers
 * removed. `base` carries the inherited style (used when recursing into the
 * body of a bold/italic span so emphasis nests).
 */
export function parseInline(line: string, t: Theme, base: Partial<InlineSegment> = {}): InlineSegment[] {
  const out: InlineSegment[] = [];
  let i = 0;
  let plainStart = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) pushText(out, line.slice(plainStart, end), base);
  };

  while (i < line.length) {
    const ch = line[i];

    // Inline code: `code` — highest precedence, no nested formatting inside.
    if (ch === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i) {
        flushPlain(i);
        out.push({ text: line.slice(i + 1, end), fg: t.mdCode });
        i = end + 1;
        plainStart = i;
        continue;
      }
    }

    // Link: [label](url) — show the label as an underlined link, drop the url.
    if (ch === "[") {
      const close = line.indexOf("]", i + 1);
      if (close > i && line[close + 1] === "(") {
        const urlEnd = line.indexOf(")", close + 2);
        if (urlEnd > close) {
          flushPlain(i);
          const label = line.slice(i + 1, close);
          for (const seg of parseInline(label, t, { ...base, fg: t.mdLinkText, underline: true })) out.push(seg);
          i = urlEnd + 1;
          plainStart = i;
          continue;
        }
      }
    }

    // Emphasis markers.
    let matched = false;
    for (const m of INLINE) {
      if (!line.startsWith(m.open, i)) continue;
      const close = line.indexOf(m.close, i + m.open.length);
      if (close < 0) continue; // unterminated → treat as literal
      const inner = line.slice(i + m.open.length, close);
      if (inner.length === 0) continue;
      flushPlain(i);
      const isBold = "bold" in m && m.bold;
      const isItalic = "italic" in m && m.italic;
      const isStrike = "strike" in m && m.strike;
      const childBase: Partial<InlineSegment> = {
        ...base,
        bold: base.bold || isBold || undefined,
        italic: base.italic || isItalic || undefined,
        strike: base.strike || isStrike || undefined,
        fg: base.fg ?? (isBold ? t.mdBold : isItalic ? t.mdItalic : isStrike ? t.textMuted : undefined),
      };
      for (const seg of parseInline(inner, t, childBase)) out.push(seg);
      i = close + m.close.length;
      plainStart = i;
      matched = true;
      break;
    }
    if (matched) continue;

    i++;
  }
  flushPlain(line.length);
  return out;
}

type Block =
  | { kind: "heading"; level: number; segs: InlineSegment[] }
  | { kind: "para"; segs: InlineSegment[] }
  | { kind: "bullet"; indent: number; segs: InlineSegment[] }
  | { kind: "ordered"; indent: number; marker: string; segs: InlineSegment[] }
  | { kind: "quote"; segs: InlineSegment[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "hr" }
  | { kind: "blank" };

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])\1{2,}\s*$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

function parseBlocks(content: string, t: Theme): Block[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const lang = fence[2] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (or run off the end — streaming-safe)
      blocks.push({ kind: "code", lang, lines: body });
      continue;
    }
    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, segs: parseInline(h[2], t, { fg: t.mdHeading, bold: true }) });
      i++;
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      blocks.push({ kind: "quote", segs: parseInline(q[1], t, { fg: t.mdItalic, italic: true }) });
      i++;
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      blocks.push({ kind: "bullet", indent: b[1].length, segs: parseInline(b[2], t) });
      i++;
      continue;
    }
    const o = ORDERED.exec(line);
    if (o) {
      blocks.push({ kind: "ordered", indent: o[1].length, marker: `${o[2]}.`, segs: parseInline(o[3], t) });
      i++;
      continue;
    }
    blocks.push({ kind: "para", segs: parseInline(line, t) });
    i++;
  }
  return blocks;
}

function Spans({ segs }: { segs: InlineSegment[] }) {
  // opentui sets bold/italic/underline via the <b>/<i>/<u> text-modifier
  // elements, NOT via span style flags. Compose them around a colored <span>.
  return (
    <>
      {segs.map((s, i) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional within a line
        let node = (
          <span key={`s${i}`} style={s.fg ? { fg: s.fg } : undefined}>
            {s.text}
          </span>
        ) as ReactNode;
        if (s.underline) node = <u key={`u${i}`}>{node}</u>;
        if (s.italic) node = <i key={`i${i}`}>{node}</i>;
        if (s.bold) node = <b key={`b${i}`}>{node}</b>;
        return node;
      })}
    </>
  );
}

/**
 * Render markdown `content` into themed opentui nodes with all syntax markers
 * concealed. Returns a column box; safe to embed inside any flex container.
 */
export function renderMarkdown(content: string, t: Theme) {
  const blocks = parseBlocks(content, t);
  return (
    <box flexDirection="column" flexShrink={0}>
      {blocks.map((blk, idx) => {
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and re-rendered wholesale
        const key = `b${idx}`;
        switch (blk.kind) {
          case "blank":
            return <box key={key} height={1} />;
          case "hr":
            return (
              <text key={key} fg={t.mdHr}>
                {"─".repeat(40)}
              </text>
            );
          case "heading":
            return (
              <text key={key} marginTop={idx === 0 ? 0 : 1}>
                <Spans segs={blk.segs} />
              </text>
            );
          case "quote":
            return (
              <text key={key}>
                <span style={{ fg: t.mdHr }}>{"▏ "}</span>
                <Spans segs={blk.segs} />
              </text>
            );
          case "bullet":
            return (
              <text key={key}>
                <span style={{ fg: t.text }}>{" ".repeat(blk.indent)}</span>
                <span style={{ fg: t.mdListBullet }}>{"• "}</span>
                <Spans segs={blk.segs} />
              </text>
            );
          case "ordered":
            return (
              <text key={key}>
                <span style={{ fg: t.text }}>{" ".repeat(blk.indent)}</span>
                <span style={{ fg: t.mdListBullet }}>{`${blk.marker} `}</span>
                <Spans segs={blk.segs} />
              </text>
            );
          case "code": {
            const lang = detectLang(`x.${blk.lang || "txt"}`);
            return (
              <box key={key} backgroundColor={t.mdCodeBlockBg} paddingLeft={1} paddingRight={1} flexDirection="column">
                {blk.lines.map((ln, j) => {
                  const toks = lang === "plain" ? [] : tokenize(ln, lang, t);
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: code lines are positional
                    <text key={`c${j}`}>
                      {toks.length === 0 ? (
                        <span style={{ fg: t.mdCodeBlockFg }}>{ln || " "}</span>
                      ) : (
                        toks.map((tok, k) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: token positions are stable per render
                          <span key={`t${k}`} style={{ fg: tok.fg }}>
                            {tok.text}
                          </span>
                        ))
                      )}
                    </text>
                  );
                })}
              </box>
            );
          }
          default:
            return (
              <text key={key}>
                <Spans segs={blk.segs} />
              </text>
            );
        }
      })}
    </box>
  );
}
