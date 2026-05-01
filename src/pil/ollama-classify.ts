/**
 * src/pil/ollama-classify.ts
 *
 * Ollama-based intent classification fallback for Layer 1.
 * Called only when regex classifier and keyword fallback both miss.
 * 150ms timeout via AbortController — fail-open on any error.
 */

import type { TaskType } from './types.js';

export interface OllamaClassifyResult {
  taskType: TaskType;
  confidence: number;
}

const OLLAMA_TIMEOUT_MS = 150;
const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_MODEL = 'gemma2:2b';

const VALID_TASK_TYPES: TaskType[] = ['refactor', 'debug', 'plan', 'analyze', 'documentation', 'generate'];

export async function ollamaClassify(prompt: string): Promise<OllamaClassifyResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `Classify this prompt into exactly one category: refactor, debug, plan, analyze, documentation, generate, or none. Reply with ONLY the category name.\n\nPrompt: "${prompt}"`,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    if (!response.ok) return null;

    const data = await response.json() as { response?: string };
    const raw = (data.response ?? '').trim().toLowerCase();
    const matched = VALID_TASK_TYPES.find(t => raw.includes(t));

    return matched ? { taskType: matched, confidence: 0.55 } : null;
  } catch {
    return null;
  }
}
