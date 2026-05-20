import type { PaymentSettings } from "../../utils/settings.js";
import { WALLET_ROWS } from "../constants.js";
import type { Theme } from "../theme.js";
import type { WalletDisplayInfo } from "../types.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

export function PaymentApprovalPanel({
  t,
  payment,
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
    approvalId?: string;
    selected: number;
  };
}) {
  const options = ["Approve payment", "Reject"];
  return (
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
          <b>{"Payment required"}</b>
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
        <text>
          <span style={{ fg: t.textMuted }}>{"Price: "}</span>
          <span style={{ fg: "#22c55e" }}>
            <b>{`${payment.amount} USDC`}</b>
          </span>
          <span style={{ fg: t.textMuted }}>{` on ${payment.network}`}</span>
        </text>
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
          <span style={{ fg: t.textMuted }}>{" reject"}</span>
        </text>
      </box>
    </box>
  );
}

export function WalletPickerModal({
  t,
  settings,
  walletInfo,
  focusIndex,
  width,
  height,
}: {
  t: Theme;
  settings: Required<PaymentSettings>;
  walletInfo: WalletDisplayInfo;
  focusIndex: number;
  width: number;
  height: number;
}) {
  const panelHeight = Math.min(WALLET_ROWS.length + 6, Math.floor(height * 0.6));
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;

  return (
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
  );
}
