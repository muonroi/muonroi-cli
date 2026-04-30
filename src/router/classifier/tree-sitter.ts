import type { ClassifierResult } from '../types.js';
import { loadGrammarBytes, type GrammarId } from './grammars.js';

type ParserHandle = { parser: any; lang: any };
const cache = new Map<GrammarId, ParserHandle>();
let initOnce: Promise<void> | null = null;

// Resolve web-tree-sitter classes from dynamic import (CJS/ESM compat)
function resolveModule(mod: any): { Parser: any; Language: any } {
  // Named exports take priority, then nested under default
  const Parser = mod.Parser ?? mod.default?.Parser;
  const Language = mod.Language ?? mod.default?.Language;
  return { Parser, Language };
}

async function initParser(): Promise<void> {
  if (initOnce) return initOnce;
  initOnce = (async () => {
    const ts = await import('web-tree-sitter');
    const { Parser } = resolveModule(ts);
    await Parser.init();
  })();
  return initOnce;
}

export async function initTreeSitter(
  grammars: GrammarId[] = ['typescript', 'python'],
): Promise<void> {
  await initParser();
  const ts = await import('web-tree-sitter');
  const { Parser, Language } = resolveModule(ts);
  for (const id of grammars) {
    if (cache.has(id)) continue;
    const bytes = await loadGrammarBytes(id);
    const lang = await Language.load(bytes);
    const parser = new Parser();
    parser.setLanguage(lang);
    cache.set(id, { parser, lang });
  }
}

// Fire-and-forget warm at boot
export function warmTreeSitter(): void {
  void initTreeSitter();
}

function detectLang(prompt: string): GrammarId | null {
  if (/```(ts|tsx|typescript)\b/i.test(prompt)) return 'typescript';
  if (/```(py|python)\b/i.test(prompt)) return 'python';
  return null;
}

export function lazyTreeSitter(prompt: string): ClassifierResult {
  const id = detectLang(prompt);
  if (!id) {
    return {
      tier: 'abstain',
      confidence: 0.0,
      reason: 'tree-sitter:no-fenced-code',
    };
  }
  const handle = cache.get(id);
  if (!handle) {
    return { tier: 'abstain', confidence: 0.3, reason: 'tree-sitter:cold' };
  }
  // Extract fenced code body (best-effort)
  const m = prompt.match(/```\w+\n([\s\S]*?)```/);
  const body = m ? m[1] : prompt;
  try {
    const tree = handle.parser.parse(body);
    // Confidence based on syntactically meaningful node count
    const root = tree.rootNode;
    const named = root.namedChildCount;
    const errs = root.hasError ? 1 : 0;
    const conf = named >= 1 && !errs ? 0.8 : named >= 1 ? 0.55 : 0.3;
    return {
      tier: conf >= 0.55 ? 'hot' : 'abstain',
      confidence: conf,
      reason: `tree-sitter:${id}`,
      modelHint: 'claude-3-5-sonnet-latest',
    };
  } catch {
    return {
      tier: 'abstain',
      confidence: 0.0,
      reason: `tree-sitter:${id}-parse-error`,
    };
  }
}
