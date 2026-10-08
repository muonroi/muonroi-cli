import { streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";

const controller = new AbortController();
const start = Date.now();
const model = new MockLanguageModelV3({ doStream: async () => new Promise(() => {}) });
const result = streamText({ model, prompt: "probe", abortSignal: controller.signal, maxRetries: 0 });
setTimeout(() => {
  console.log("abort", Date.now() - start);
  controller.abort(new DOMException("provider-stall", "TimeoutError"));
}, 200);
const consume = (async () => {
  for await (const part of result.fullStream) console.log("part", part.type, Date.now() - start);
  return "ended";
})();
console.log(await Promise.race([consume, new Promise((r) => setTimeout(() => r("still blocked after abort"), 500))]));
