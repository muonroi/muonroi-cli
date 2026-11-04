import { describe, expect, it } from "vitest";
import { delegationNotificationForDisplay } from "../delegation-display.js";
import { backgroundWakeLabel, buildBackgroundWakePrompt } from "../../../utils/background-jobs.js";
describe("worker message notice display", () => {
  it("keeps worker text and status while hiding host correlation instructions from the user", () => {
    const raw =
      "[Worker messages jobId=owned-worker status=running]\n\n[worker-message:stable-id] messageId=stable-id sequence=1 sender=worker kind=question deadlineAt=2026-10-17T11:00:00Z\nWhich fixture?\n\nDetails remain intact.\n\nReply to a question with delegation_send({id: jobId, message: answer, replyTo: messageId}). Messages do not verify or accept work.";
    const display = delegationNotificationForDisplay(raw);
    expect(display).toBe("Worker owned-worker (running)\n\nQuestion\nWhich fixture?\n\nDetails remain intact.");
    expect(raw).toContain("messageId=stable-id");
  });
  it("preserves unrelated text and an incomplete frame", () => {
    for (const content of ["ordinary worker text", "[Worker messages jobId=worker status=running]\n\nuser content"])
      expect(delegationNotificationForDisplay(content)).toBe(content);
  });
  it("labels running worker messages as updates instead of finished work", () => {
    const notices = ["[Worker messages jobId=worker status=running]\n\nquestion"];
    expect(backgroundWakeLabel(notices)).toContain("update");
    expect(backgroundWakeLabel(notices)).not.toContain("finished");
    expect(buildBackgroundWakePrompt(notices)).toContain("still running");
    expect(buildBackgroundWakePrompt(notices)).not.toContain("has finished");
    expect(backgroundWakeLabel(["Background agent complete: worker"])).toContain("finished");
  });
});
