import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { MODAL_SURFACE_PRIORITY } from "../modal-focus.js";

// Execute the actual shared interrupt callback used by all three input paths.
// The large UI hook has no standalone renderer-free export for this callback.
const source = readFileSync(new URL("../use-app-logic.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("  const interruptActiveRun = useCallback(");
const end = source.indexOf("\n  useEffect(() => {\n    const onInternalKey", start);
if (start < 0 || end < start) throw new Error("Could not locate shared interrupt callback");
const body = ts.transpileModule(source.slice(start, end) + "\nreturn interruptActiveRun;", {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function fixture(modal: string | null, queued = false, slashMenu = false) {
  const abort = vi.fn();
  const clearLiveTurnUi = vi.fn();
  const setQueuedMessages = vi.fn();
  const queue = { current: queued ? ["follow-up"] : [] };
  const context = {
    useCallback: (fn: unknown) => fn,
    modalKeyboardOwnerRef: { current: modal },
    showSlashMenuRef: { current: slashMenu },
    councilSteerModeRef: { current: false },
    setCouncilSteerMode: vi.fn(),
    btwStateRef: { current: null },
    btwAbortRef: { current: null },
    setBtwState: vi.fn(),
    pendingCouncilQuestionRef: { current: null },
    preflightCardStateRef: { current: null },
    isProcessingRef: { current: true },
    queuedMessagesRef: queue,
    setQueuedMessages,
    interruptedRunIdRef: { current: null },
    activeRunIdRef: { current: "active-run" },
    activeTurnRef: { current: { agent: { abort } } },
    agent: { abort },
    clearLiveTurnUi,
  };
  const interrupt = new Function(...Object.keys(context), body)(...Object.values(context));
  return { interrupt, abort, clearLiveTurnUi, setQueuedMessages, queue };
}

describe("modal Escape ownership across shared interrupt paths", () => {
  it.each(MODAL_SURFACE_PRIORITY)("leaves the active turn and queued input intact while %s owns Escape", (modal) => {
    const f = fixture(modal, true);
    expect(f.interrupt()).toBe(false);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.clearLiveTurnUi).not.toHaveBeenCalled();
    expect(f.queue.current).toEqual(["follow-up"]);
    expect(f.setQueuedMessages).not.toHaveBeenCalled();
  });

  it("lets the slash menu own Escape", () => {
    const f = fixture(null, false, true);
    expect(f.interrupt()).toBe(false);
    expect(f.abort).not.toHaveBeenCalled();
  });

  it("still aborts an active turn with no modal or queue", () => {
    const f = fixture(null);
    expect(f.interrupt()).toBe(true);
    expect(f.abort).toHaveBeenCalledOnce();
  });

  it("still clears queued input before aborting with no modal", () => {
    const f = fixture(null, true);
    expect(f.interrupt()).toBe(true);
    expect(f.queue.current).toEqual([]);
    expect(f.abort).not.toHaveBeenCalled();
  });
});
