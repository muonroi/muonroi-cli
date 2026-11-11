import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "../../../src/models/registry.js";
import { Agent } from "../../../src/orchestrator/orchestrator.js";
import { routerStore } from "../../../src/router/store.js";
import { statusBarStore } from "../../../src/state/status-bar-store.js";
import { SessionStore } from "../../../src/storage/sessions.js";
import { appendMessages } from "../../../src/storage/transcript.js";
import { emitDowngrade } from "../../../src/usage/downgrade.js";

const home = process.env.MUONROI_STATUS_FIXTURE_HOME;
if (!home || process.env.HOME !== home || process.env.USERPROFILE !== home)
  throw new Error("status fixture requires isolated HOME/USERPROFILE");
const session = new SessionStore(process.cwd()).createSession("deepseek-v4-flash", "agent", process.cwd());
appendMessages(session.id, [
  { role: "user", content: "Coordinate the fixture." },
  { role: "assistant", content: "Ready to coordinate." },
]);
process.argv.push("--session", session.id);
let owner: Agent | undefined;
const getModel = Agent.prototype.getModel;
Agent.prototype.getModel = function () {
  if (this.getExecutionRole() === "orchestrator") owner = this;
  return getModel.call(this);
};
await import("../../../src/index.ts");
let last = "";
const control = join(home, "status-trigger.txt");
const receipt = join(home, "status-receipt.json");
setInterval(() => {
  if (!owner || !existsSync(control)) return;
  const command = readFileSync(control, "utf8").trim();
  if (command === last) return;
  last = command;
  try {
    const helper = MODELS.find((m) => m.provider === owner!.getProviderId() && m.tier === "fast");
    if (!helper) throw new Error("No fast fixture helper in the owner's provider catalog");
    if (command === "footer") {
      statusBarStore.setState({
        in_tokens: 5_200_000,
        out_tokens: 165400,
        cache_read_tokens: 2_700_000,
        session_usd: 2.89,
        ctx_pct: 13,
        permission_mode: "yolo",
        routing_mode: "fixed",
        ee_status: "ok",
        degraded: true,
        compaction_summary: `8 cmp, 237.0K saved via ${helper.id} ⚠ long session — consider /clear`,
      });
    } else if (command === "compaction") {
      (
        owner as unknown as {
          recordUsage: (usage: { inputTokens: number; outputTokens: number }, source: string, model: string) => void;
        }
      ).recordUsage({ inputTokens: 777, outputTokens: 11 }, "compaction", helper.id);
    } else if (command === "router") {
      routerStore.setState({
        tier: "warm",
        lastDecision: { tier: "warm", provider: helper.provider!, model: helper.id, reason: "fixture-auxiliary" },
      });
    } else if (command === "downgrade") {
      emitDowngrade({ fromModel: owner.getModel(), toModel: helper.id, pct: 80, atMs: Date.now() });
    }
    writeFileSync(
      receipt,
      JSON.stringify({
        command,
        rootModel: owner.getModel(),
        rootProvider: owner.getProviderId(),
        helper: helper.id,
        displayed: statusBarStore.getState(),
      }),
    );
  } catch (err) {
    console.error("Status fixture action failed:", err instanceof Error ? err.message : String(err));
    writeFileSync(receipt, JSON.stringify({ command, error: err instanceof Error ? err.message : String(err) }));
  }
}, 50);
