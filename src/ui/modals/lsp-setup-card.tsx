import { Semantic } from "@muonroi/agent-harness-opentui";
import type { LspInstallStatus } from "../../lsp/lsp-setup.js";
import type { LspSetupLanguageOption } from "../lsp-setup-controller.js";
import type { Theme } from "../theme.js";
import { bottomAlignedModalTop } from "../utils/modal.js";

export type LspSetupCardMode = "pick" | "installing" | "result";

/**
 * Inline first-run "which languages do you work in?" card. Parallel to
 * EeConnectCard (same modal-stack + key-precedence pattern) but a separate
 * component — LSP onboarding and EE onboarding must not couple. Unlike the
 * single-select cards, this one is MULTI-SELECT: Space toggles the language
 * under the cursor, Enter installs the whole picked set, Esc snoozes.
 */
export function LspSetupCard({
  t,
  width,
  height,
  languages,
  selectedIds,
  detectedIds,
  cursorIndex,
  mode,
  statuses,
}: {
  t: Theme;
  width: number;
  height: number;
  languages: LspSetupLanguageOption[];
  selectedIds: ReadonlySet<string>;
  detectedIds: ReadonlySet<string>;
  cursorIndex: number;
  mode: LspSetupCardMode;
  statuses: LspInstallStatus[];
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(78, width - 6);
  // Result rows can carry a manual command that word-wraps; count wrapped rows
  // (same trap as the EE how-view) so the footer never gets pushed off-screen.
  const contentWidth = Math.max(1, panelWidth - 4);
  const resultRows = statuses.reduce((sum, status) => {
    const line = statusLine(status);
    return sum + Math.max(1, Math.ceil(line.length / contentWidth));
  }, 0);
  const bodyHeight = mode === "pick" ? languages.length : mode === "result" ? Math.max(1, resultRows) : 2;
  const panelHeight = Math.min(9 + bodyHeight, Math.floor(height * 0.8));
  const top = bottomAlignedModalTop(height, panelHeight);
  const cursorHint = languages[cursorIndex]?.hint ?? "";
  const pickedCount = languages.filter((lang) => selectedIds.has(lang.id)).length;

  return (
    <Semantic id="lsp-setup-card" role="dialog" name="Set up language servers" isModal>
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
          width={panelWidth}
          height={panelHeight}
          backgroundColor={t.backgroundPanel}
          paddingTop={1}
          paddingBottom={1}
          flexDirection="column"
        >
          <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
            <text fg={t.primary}>
              <b>{"Set up language servers"}</b>
            </text>
            <text fg={t.textMuted}>{"esc"}</text>
          </box>
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            <text fg={t.text}>
              {mode === "installing"
                ? `Installing ${pickedCount} language server${pickedCount === 1 ? "" : "s"}…`
                : mode === "result"
                  ? "Install results — commands shown must be run manually."
                  : "Which languages do you work in? Picked ones get diagnostics & code navigation."}
            </text>
            {mode === "pick" && <text fg={t.textMuted}>{cursorHint}</text>}
          </box>
          {mode === "result" ? (
            <Semantic id="lsp-setup-results" role="listbox">
              <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
                {statuses.map((status) => (
                  <Semantic
                    key={status.id}
                    id={`lsp-setup-result-${status.id}`}
                    role="listitem"
                    name={`${status.label}: ${status.status}`}
                  >
                    <text
                      fg={
                        status.status === "installed"
                          ? t.diffAddedFg
                          : status.status === "failed"
                            ? t.diffRemovedFg
                            : t.text
                      }
                    >
                      {statusLine(status)}
                    </text>
                  </Semantic>
                ))}
              </box>
            </Semantic>
          ) : mode === "pick" ? (
            <Semantic id="lsp-setup-langs" role="listbox">
              <box flexShrink={0} flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
                {languages.map((lang, idx) => {
                  const underCursor = idx === cursorIndex;
                  const picked = selectedIds.has(lang.id);
                  const detected = detectedIds.has(lang.id);
                  return (
                    <Semantic
                      key={lang.id}
                      id={`lsp-setup-lang-${lang.id}`}
                      role="listitem"
                      name={lang.label}
                      selected={picked || undefined}
                    >
                      <box backgroundColor={underCursor ? t.selectedBg : undefined} paddingLeft={1} paddingRight={1}>
                        <text fg={underCursor ? t.selected : t.text}>
                          {underCursor ? "› " : "  "}
                          {picked ? "[x] " : "[ ] "}
                          {lang.label}
                          {detected ? "  (detected)" : ""}
                        </text>
                      </box>
                    </Semantic>
                  );
                })}
              </box>
            </Semantic>
          ) : (
            <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
              <text fg={t.textMuted}>{"npm servers warm into the cache; toolchain installs may take a minute."}</text>
            </box>
          )}
          <box flexGrow={1} minHeight={0} />
          <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
            {mode === "installing" ? (
              <text fg={t.textMuted}>{"Installing…"}</text>
            ) : mode === "result" ? (
              <text>
                <span style={{ fg: t.primary }}>{"enter "}</span>
                <span style={{ fg: t.textMuted }}>{"close  ·  "}</span>
                <span style={{ fg: t.primary }}>{"esc "}</span>
                <span style={{ fg: t.textMuted }}>{"close"}</span>
              </text>
            ) : (
              <text>
                <span style={{ fg: t.primary }}>{"↑↓ "}</span>
                <span style={{ fg: t.textMuted }}>{"move  ·  "}</span>
                <span style={{ fg: t.primary }}>{"space "}</span>
                <span style={{ fg: t.textMuted }}>{`toggle (${pickedCount} picked)  ·  `}</span>
                <span style={{ fg: t.primary }}>{"enter "}</span>
                <span style={{ fg: t.textMuted }}>{"install  ·  "}</span>
                <span style={{ fg: t.primary }}>{"esc "}</span>
                <span style={{ fg: t.textMuted }}>{"not now"}</span>
              </text>
            )}
          </box>
        </box>
      </box>
    </Semantic>
  );
}

function statusLine(status: LspInstallStatus): string {
  if (status.status === "installed") return `✓ ${status.label} — ${status.detail ?? "installed"}`;
  if (status.status === "failed")
    return `✗ ${status.label} — ${status.detail ?? "install failed"}${status.command ? ` (try: ${status.command})` : ""}`;
  return `→ ${status.label} — run: ${status.command ?? ""}${status.detail ? ` (${status.detail})` : ""}`;
}
