import type { Theme } from "./theme";

export type Token = { text: string; fg: string };

export type Lang =
  | "ts"
  | "tsx"
  | "js"
  | "jsx"
  | "json"
  | "py"
  | "sh"
  | "yaml"
  | "css"
  | "html"
  | "md"
  | "plain";

export function detectLang(filePath: string | undefined): Lang {
  if (!filePath) return "plain";
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return "plain";
  const ext = lower.slice(dot + 1);
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "js";
    case "jsx":
      return "jsx";
    case "json":
    case "jsonc":
      return "json";
    case "py":
    case "pyi":
      return "py";
    case "sh":
    case "bash":
    case "zsh":
      return "sh";
    case "yaml":
    case "yml":
      return "yaml";
    case "css":
    case "scss":
    case "sass":
      return "css";
    case "html":
    case "htm":
    case "xml":
    case "svg":
      return "html";
    case "md":
    case "markdown":
      return "md";
    default:
      return "plain";
  }
}

const TS_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "is", "keyof", "let",
  "namespace", "new", "of", "override", "package", "private", "protected",
  "public", "readonly", "return", "satisfies", "set", "static", "super",
  "switch", "this", "throw", "try", "type", "typeof", "var", "void", "while",
  "with", "yield",
]);

const TS_BUILTINS = new Set([
  "Array", "Boolean", "Date", "Error", "Function", "JSON", "Map", "Math",
  "Number", "Object", "Promise", "RegExp", "Set", "String", "Symbol", "WeakMap",
  "WeakSet", "console", "globalThis", "undefined", "NaN", "Infinity",
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude",
  "Extract", "ReturnType", "Parameters", "Awaited", "string", "number",
  "boolean", "any", "unknown", "never", "object", "bigint", "symbol",
]);

const TS_LITERALS = new Set(["true", "false", "null", "undefined"]);

const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  "match", "case",
]);

const PY_BUILTINS = new Set([
  "print", "len", "range", "str", "int", "float", "bool", "list", "dict",
  "set", "tuple", "type", "isinstance", "open", "self", "cls",
]);

const SH_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case",
  "esac", "in", "function", "return", "exit", "export", "local", "readonly",
  "set", "unset", "echo", "printf",
]);

const ID_RE = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUM_RE = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?n?)/y;

function tokenizeJsLike(line: string, t: Theme, lang: Lang): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = line.length;
  const isJsx = lang === "tsx" || lang === "jsx";

  while (i < n) {
    const ch = line[i];
    const next = line[i + 1];

    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < n && (line[j] === " " || line[j] === "\t")) j++;
      out.push({ text: line.slice(i, j), fg: t.diffContextFg });
      i = j;
      continue;
    }

    if (ch === "/" && next === "/") {
      out.push({ text: line.slice(i), fg: t.syntaxComment });
      i = n;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out.push({ text: line.slice(i, stop), fg: t.syntaxComment });
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      out.push({ text: line.slice(i, j), fg: t.syntaxString });
      i = j;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(line);
      if (m && m.index === i) {
        out.push({ text: m[0], fg: t.syntaxNumber });
        i += m[0].length;
        continue;
      }
    }

    if (isJsx && ch === "<" && (next === "/" || (next >= "A" && next <= "z"))) {
      let j = i + 1;
      if (line[j] === "/") j++;
      while (j < n && /[A-Za-z0-9_.\-]/.test(line[j])) j++;
      out.push({ text: line.slice(i, j), fg: t.syntaxTag });
      i = j;
      continue;
    }

    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_" || ch === "$") {
      ID_RE.lastIndex = i;
      const m = ID_RE.exec(line);
      if (m && m.index === i) {
        const word = m[0];
        const after = line[i + word.length];
        let fg: string;
        if (TS_KEYWORDS.has(word)) fg = t.syntaxKeyword;
        else if (TS_LITERALS.has(word)) fg = t.syntaxBoolean;
        else if (TS_BUILTINS.has(word)) fg = t.syntaxBuiltin;
        else if (after === "(") fg = t.syntaxFunction;
        else if (word[0] >= "A" && word[0] <= "Z") fg = t.syntaxType;
        else fg = t.diffContextFg;
        out.push({ text: word, fg });
        i += word.length;
        continue;
      }
    }

    if ("(){}[],;:.".includes(ch)) {
      out.push({ text: ch, fg: t.syntaxPunct });
      i++;
      continue;
    }

    if ("=+-*/%<>!&|^~?".includes(ch)) {
      out.push({ text: ch, fg: t.syntaxOperator });
      i++;
      continue;
    }

    out.push({ text: ch, fg: t.diffContextFg });
    i++;
  }

  return out;
}

function tokenizePython(line: string, t: Theme): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < n && (line[j] === " " || line[j] === "\t")) j++;
      out.push({ text: line.slice(i, j), fg: t.diffContextFg });
      i = j;
      continue;
    }

    if (ch === "#") {
      out.push({ text: line.slice(i), fg: t.syntaxComment });
      i = n;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      out.push({ text: line.slice(i, j), fg: t.syntaxString });
      i = j;
      continue;
    }

    if (ch >= "0" && ch <= "9") {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(line);
      if (m && m.index === i) {
        out.push({ text: m[0], fg: t.syntaxNumber });
        i += m[0].length;
        continue;
      }
    }

    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_") {
      ID_RE.lastIndex = i;
      const m = ID_RE.exec(line);
      if (m && m.index === i) {
        const word = m[0];
        const after = line[i + word.length];
        let fg: string;
        if (PY_KEYWORDS.has(word)) fg = t.syntaxKeyword;
        else if (PY_BUILTINS.has(word)) fg = t.syntaxBuiltin;
        else if (after === "(") fg = t.syntaxFunction;
        else if (word[0] >= "A" && word[0] <= "Z") fg = t.syntaxType;
        else fg = t.diffContextFg;
        out.push({ text: word, fg });
        i += word.length;
        continue;
      }
    }

    if ("(){}[],;:.".includes(ch)) {
      out.push({ text: ch, fg: t.syntaxPunct });
      i++;
      continue;
    }
    if ("=+-*/%<>!&|^~@".includes(ch)) {
      out.push({ text: ch, fg: t.syntaxOperator });
      i++;
      continue;
    }

    out.push({ text: ch, fg: t.diffContextFg });
    i++;
  }

  return out;
}

function tokenizeShell(line: string, t: Theme): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = line.length;

  while (i < n) {
    const ch = line[i];

    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < n && (line[j] === " " || line[j] === "\t")) j++;
      out.push({ text: line.slice(i, j), fg: t.diffContextFg });
      i = j;
      continue;
    }
    if (ch === "#") {
      out.push({ text: line.slice(i), fg: t.syntaxComment });
      i = n;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === quote) { j++; break; }
        j++;
      }
      out.push({ text: line.slice(i, j), fg: t.syntaxString });
      i = j;
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      if (line[j] === "{") {
        const close = line.indexOf("}", j + 1);
        j = close < 0 ? n : close + 1;
      } else {
        while (j < n && /[A-Za-z0-9_]/.test(line[j])) j++;
      }
      out.push({ text: line.slice(i, j), fg: t.syntaxVariable });
      i = j;
      continue;
    }
    if ((ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_") {
      ID_RE.lastIndex = i;
      const m = ID_RE.exec(line);
      if (m && m.index === i) {
        const word = m[0];
        const fg = SH_KEYWORDS.has(word) ? t.syntaxKeyword : t.diffContextFg;
        out.push({ text: word, fg });
        i += word.length;
        continue;
      }
    }
    if (ch >= "0" && ch <= "9") {
      let j = i;
      while (j < n && line[j] >= "0" && line[j] <= "9") j++;
      out.push({ text: line.slice(i, j), fg: t.syntaxNumber });
      i = j;
      continue;
    }
    out.push({ text: ch, fg: t.diffContextFg });
    i++;
  }
  return out;
}

function tokenizeJson(line: string, t: Theme): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      let j = i;
      while (j < n && (line[j] === " " || line[j] === "\t")) j++;
      out.push({ text: line.slice(i, j), fg: t.diffContextFg });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === '"') { j++; break; }
        j++;
      }
      let k = j;
      while (k < n && (line[k] === " " || line[k] === "\t")) k++;
      const isKey = line[k] === ":";
      out.push({ text: line.slice(i, j), fg: isKey ? t.syntaxProperty : t.syntaxString });
      i = j;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === "-") {
      NUM_RE.lastIndex = ch === "-" ? i + 1 : i;
      const m = NUM_RE.exec(line);
      if (m) {
        const start = ch === "-" ? i : i;
        const end = (ch === "-" ? i + 1 : i) + m[0].length;
        out.push({ text: line.slice(start, end), fg: t.syntaxNumber });
        i = end;
        continue;
      }
    }
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z")) {
      ID_RE.lastIndex = i;
      const m = ID_RE.exec(line);
      if (m && m.index === i) {
        const word = m[0];
        const fg = TS_LITERALS.has(word) ? t.syntaxBoolean : t.diffContextFg;
        out.push({ text: word, fg });
        i += word.length;
        continue;
      }
    }
    if ("{}[],:".includes(ch)) {
      out.push({ text: ch, fg: t.syntaxPunct });
      i++;
      continue;
    }
    out.push({ text: ch, fg: t.diffContextFg });
    i++;
  }
  return out;
}

function tokenizeYaml(line: string, t: Theme): Token[] {
  const out: Token[] = [];
  const m = /^(\s*)(-\s+)?([^:#\s][^:#]*?)(\s*:)?(\s*)(.*)$/.exec(line);
  if (!m) return [{ text: line, fg: t.diffContextFg }];
  const [, indent, dash, key, colon, mid, rest] = m;
  if (indent) out.push({ text: indent, fg: t.diffContextFg });
  if (dash) out.push({ text: dash, fg: t.syntaxPunct });
  if (key) {
    if (colon) out.push({ text: key, fg: t.syntaxProperty });
    else out.push({ text: key, fg: t.diffContextFg });
  }
  if (colon) out.push({ text: colon, fg: t.syntaxPunct });
  if (mid) out.push({ text: mid, fg: t.diffContextFg });
  if (rest) {
    if (rest.startsWith("#")) out.push({ text: rest, fg: t.syntaxComment });
    else if (/^(true|false|null|~)$/.test(rest)) out.push({ text: rest, fg: t.syntaxBoolean });
    else if (/^-?\d/.test(rest)) out.push({ text: rest, fg: t.syntaxNumber });
    else if (rest.startsWith('"') || rest.startsWith("'")) out.push({ text: rest, fg: t.syntaxString });
    else out.push({ text: rest, fg: t.syntaxString });
  }
  return out;
}

export function tokenize(line: string, lang: Lang, t: Theme): Token[] {
  if (line.length === 0) return [];
  switch (lang) {
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return tokenizeJsLike(line, t, lang);
    case "py":
      return tokenizePython(line, t);
    case "sh":
      return tokenizeShell(line, t);
    case "json":
      return tokenizeJson(line, t);
    case "yaml":
      return tokenizeYaml(line, t);
    default:
      return [{ text: line, fg: t.diffContextFg }];
  }
}
