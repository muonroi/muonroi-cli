import type { ModelInfo } from "../types/index.js";

/**
 * Helper to fetch and map models from OpenAI-compatible APIs.
 */
export async function fetchOpenAICompatibleModels(
  baseURL: string,
  apiKey: string,
): Promise<ModelInfo[]> {
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to list models from ${baseURL}: ${response.statusText}`);
  }
  const data = (await response.json()) as { data: any[] };
  // OpenAI API returns models in the 'data' array with 'id' and 'created'
  return data.data.map((m: any) => ({
    id: m.id,
    name: m.id,
    contextWindow: 128000, // Default for most modern models
    inputPrice: 0,
    outputPrice: 0,
    reasoning: false,
    description: `Model ${m.id}`,
  }));
}
