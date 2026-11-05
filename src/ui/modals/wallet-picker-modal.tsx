import { Dialog, Region } from "../primitives/index.js";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";
import { useEffect, useState, type RefObject } from "react";
import type { WorkerApprovalView } from "../../orchestrator/worker-approval.js";
import { WALLET_ROWS } from "../constants.js";
import type { Theme } from "../theme.js";
import type { WalletDisplayInfo } from "../types.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

/** Local approval navigation never depends on composer text or transcript scroll flags. */
export function pageWorkerApprovalPreview(
  key: Pick<KeyEvent, "name" | "preventDefault" | "stopPropagation">,
  scroll: ScrollBoxRenderable | null,
): boolean {
  if (!["pageup", "pagedown", "home", "end"].includes(key.name)) return false;
  key.preventDefault();
  key.stopPropagation();
  if (scroll) {
    if (key.name === "home") scroll.scrollTo(0);
    else if (key.name === "end") scroll.scrollTo(scroll.scrollHeight);
    else scroll.scrollBy((key.name === "pageup" ? -1 : 1) * Math.max(1, scroll.viewport.height - 1));
  }
  return true;
}

/** Worker consent stays visible independently of the transcript's live-tail layout. */
export function WorkerApprovalPanel({
  t,
  width,
  height,
  request,
  selected,
  focused,
  previewRef,
}: {
  t: Theme;
  width: number;
  height: number;
  request: WorkerApprovalView;
  selected: number;
  focused?: boolean;
  previewRef: RefObject<ScrollBoxRenderable | null>;
}) {
  const panelWidth = Math.max(1, Math.min(90, width - 4));
  const contentWidth = Math.max(1, panelWidth - 6);
  // Sizing is an estimate only; the local viewport retains the complete input.
  const rows = (text: string, columns: number) =>
    text.split(/\r?\n/).reduce((total, line) => total + Math.max(1, Math.ceil(line.length / columns)), 0);
  const details = [
    `Call     ${request.toolCallId}`,
    `SHA256   ${request.inputDigest}`,
    `Deadline ${request.deadlineAt}`,
  ];
  const hints = "↑↓ select   Enter confirm   Esc deny\nA Auto   Y Yolo   PgUp/PgDn/Home/End inspect";
  const fixedRows =
    13 + details.reduce((total, line) => total + rows(line, contentWidth), 0) + rows(hints, contentWidth);
  const inputRows = Math.max(3, Math.min(12, rows(request.preview, Math.max(1, contentWidth - 4))));
  const panelHeight = Math.min(Math.max(1, height - 2), fixedRows + inputRows);
  const [geometry, setGeometry] = useState<{ scrollTop: number; viewportH: number; scrollHeight: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Each new approval must reset the preview scroll position.
  useEffect(() => {
    previewRef.current?.scrollTo(0);
    setGeometry(null);
    if (process.env.MUONROI_HARNESS_SCROLL_GEOM !== "1") return;
    const timer = setInterval(() => {
      const scroll = previewRef.current;
      if (!scroll) return;
      const next = {
        scrollTop: scroll.scrollTop,
        viewportH: scroll.viewport.height,
        scrollHeight: scroll.scrollHeight,
      };
      setGeometry((current) =>
        current &&
        current.scrollTop === next.scrollTop &&
        current.viewportH === next.viewportH &&
        current.scrollHeight === next.scrollHeight
          ? current
          : next,
      );
    }, 200);
    return () => clearInterval(timer);
  }, [request.id, previewRef]);
  return (
    <Dialog
      id="payment-approval"
      name="Worker tool approval"
      focused={focused}
      props={{ requestId: request.id, jobId: request.jobId }}
    >
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={Math.max(0, Math.floor((height - panelHeight) / 2))}
        backgroundColor={t.overlay}
      >
        <box
          width={panelWidth}
          height={panelHeight}
          border
          borderStyle="rounded"
          borderColor={t.borderActive}
          backgroundColor={t.backgroundPanel}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexShrink={0} flexDirection="column">
            <box flexDirection="row" justifyContent="space-between">
              <text fg={t.text}>
                <b>Worker tool approval</b>
              </text>
              <text fg={t.subagentAccent}>PERMISSION</text>
            </box>
            <text fg={t.accent}>
              <b>{request.toolName}</b>
            </text>
            <text fg={t.diffContextFg}>{`Worker  ${request.jobId}`}</text>
          </box>
          <Region
            id="worker-approval-preview"
            name="Complete redacted tool input"
            props={{ requestId: request.id, previewChars: request.preview.length, ...(geometry ?? {}) }}
          >
            <box
              flexGrow={1}
              minHeight={0}
              marginTop={1}
              border
              borderStyle="rounded"
              borderColor={t.border}
              title=" Request "
              backgroundColor={t.backgroundElement}
            >
              <scrollbox
                ref={previewRef}
                flexGrow={1}
                minHeight={0}
                paddingLeft={1}
                paddingRight={1}
                stickyScroll={false}
                stickyStart="top"
              >
                <text fg={t.text}>{request.preview}</text>
              </scrollbox>
            </box>
          </Region>
          <box flexShrink={0} flexDirection="column" marginTop={1}>
            {details.map((line) => (
              <text key={line} fg={t.diffContextFg}>
                {line}
              </text>
            ))}
          </box>
          <box height={1} flexShrink={0} flexDirection="row" gap={2} marginTop={1}>
            {["Allow once", "Deny"].map((label, index) => (
              <box
                key={label}
                height={1}
                flexShrink={0}
                paddingLeft={2}
                paddingRight={2}
                backgroundColor={selected === index ? (index === 0 ? t.accent : t.diffRemovedFg) : t.backgroundElement}
              >
                <text fg={selected === index ? t.background : t.text}>
                  <b>{`${selected === index ? "> " : "  "}${label}`}</b>
                </text>
              </box>
            ))}
          </box>
          <box height={rows(hints, contentWidth)} flexShrink={0}>
            <text fg={t.textMuted}>{hints}</text>
          </box>
        </box>
      </box>
    </Dialog>
  );
}

export function PaymentApprovalPanel({
  t,
  payment,
  focused,
}: {
  t: Theme;
  payment: {
    url: string;
    description: string;
    security: string;
    securityLabel: string;
    securityUrl: string;
    amount: string;
    network: string;
    asset: string;
    /** Main agent's own must-confirm tool call; `url` holds the tool name, `description` the input preview. */
    toolApproval?: import("../../orchestrator/tool-approval.js").ToolApprovalAskInfo;
    workerApproval?: import("../../orchestrator/worker-approval.js").WorkerApprovalView;
    selected: number;
  };
  /**
   * True when this surface owns the keyboard (see src/ui/modal-focus.ts).
   * Mirrored to the Semantic node's `focus` flag so exactly one node in the
   * tree carries it while this modal is open — never zero, never two.
   */
  focused?: boolean;
}) {
  // The x402 payment flow this panel was built for was removed (e1101dde); the
  // only producers left are tool approvals — the main agent's own (safe mode)
  // and a worker's.
  const worker = payment.workerApproval;
  const title = worker ? "Worker tool approval" : "Tool approval";
  const options = ["Allow once", "Deny"];
  return (
    <Dialog id="payment-approval" name={title} value={options[payment.selected]} focused={focused}>
      <box
        flexDirection="column"
        border={["left"]}
        customBorderChars={{
          topLeft: "",
          bottomLeft: "",
          vertical: "┃",
          topRight: "",
          bottomRight: "",
          horizontal: " ",
          bottomT: "",
          topT: "",
          cross: "",
          leftT: "",
          rightT: "",
        }}
        borderColor="#e5c07b"
        marginTop={1}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={t.backgroundPanel}
      >
        <text>
          <span style={{ fg: t.planTitle ?? t.primary }}>
            <b>{title}</b>
          </span>
        </text>
        <box marginTop={1} flexDirection="column">
          <text>
            <span style={{ fg: t.text }}>{payment.url}</span>
          </text>
          {payment.description ? (
            <text>
              <span style={{ fg: t.textMuted }}>{payment.description}</span>
            </text>
          ) : null}
          {payment.security ? (
            <text>
              <span style={{ fg: t.textMuted }}>{"Security: "}</span>
              <span style={{ fg: "#60a5fa" }}>{payment.securityLabel}</span>
            </text>
          ) : null}
        </box>
        <box marginTop={1} flexDirection="column">
          {options.map((label, i) => {
            const isSel = i === payment.selected;
            return (
              <text key={label}>
                <span style={{ fg: isSel ? "#22c55e" : t.textMuted }}>{isSel ? "> " : "  "}</span>
                <span style={{ fg: isSel ? t.text : t.textMuted }}>{isSel ? <b>{label}</b> : label}</span>
              </text>
            );
          })}
        </box>
        <box flexDirection="row" gap={3} marginTop={1} flexShrink={0}>
          <text>
            <span style={{ fg: t.text }}>{"↑↓"}</span>
            <span style={{ fg: t.textMuted }}>{" select"}</span>
          </text>
          <text>
            <span style={{ fg: t.text }}>{"enter"}</span>
            <span style={{ fg: t.textMuted }}>{" confirm"}</span>
          </text>
          <text>
            <span style={{ fg: t.text }}>{"esc"}</span>
            <span style={{ fg: t.textMuted }}>{" deny"}</span>
          </text>
        </box>
      </box>
    </Dialog>
  );
}

export function WalletPickerModal({
  t,
  settings,
  walletInfo,
  focusIndex,
  width,
  height,
  focused,
}: {
  t: Theme;
  settings: Record<string, unknown>;
  walletInfo: WalletDisplayInfo;
  focusIndex: number;
  width: number;
  height: number;
  /**
   * True when this surface owns the keyboard (see src/ui/modal-focus.ts).
   * Mirrored to the Semantic node's `focus` flag so exactly one node in the
   * tree carries it while this modal is open — never zero, never two.
   */
  focused?: boolean;
}) {
  const panelHeight = Math.min(WALLET_ROWS.length + 6, Math.floor(height * 0.6));
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;

  return (
    <Dialog id="wallet-picker" name="Wallet & Payments" focused={focused}>
      <box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={height}
        alignItems="center"
        paddingTop={top}
        backgroundColor={overlayBg}
      >
        <box
          width={Math.min(64, width - 6)}
          height={panelHeight}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
            <text fg={t.primary}>
              <b>{"Wallet & Payments"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <scrollbox flexGrow={1} minHeight={0}>
            {WALLET_ROWS.map((row, idx) => {
              const focused = idx === focusIndex;
              const display = row.getDisplay(settings, walletInfo);
              return (
                <box
                  key={row.key}
                  backgroundColor={focused ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                  width="100%"
                >
                  <box width="100%" flexDirection="row" justifyContent="space-between">
                    <text fg={focused ? t.selected : t.text}>{row.label}</text>
                    {row.type === "toggle" ? (
                      <text fg={focused ? t.primary : t.textMuted}>
                        {"< "}
                        {display}
                        {" >"}
                      </text>
                    ) : (
                      <text fg={focused ? t.primary : t.textMuted}>{display}</text>
                    )}
                  </box>
                </box>
              );
            })}
          </scrollbox>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.textMuted}>{"arrows navigate  left/right toggle  esc close"}</text>
          </box>
        </box>
      </box>
    </Dialog>
  );
}
