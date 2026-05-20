/**
 * InitNewFormCard — inline TUI form rendered when the user picks "Init new project"
 * from the halt recovery card.
 *
 * Minimum-scope UX (Task 5.3):
 *   Step 1: Enter project name (required, validated).
 *   Step 2: Select FE stack with ↑↓ (react / angular / none). Default: react.
 *   BE stack defaults to muonroi-building-block (MUONROI_BUILDING_BLOCK_URL or local).
 *
 * On confirm, calls onConfirm({ projectName, feStack, beSource }) so app.tsx
 * can run initNewProject() async and show a result notification.
 *
 * Wrapped in <Semantic id="init-new-form" role="dialog"> for harness visibility.
 */

import { Semantic } from "@muonroi/agent-harness-opentui";
import type { BBDesign } from "../../ee/bb-design.js";
import type { BBTemplateInfo } from "../../scaffold/init-new.js";
import type { Theme } from "../theme.js";

export type FeStack = "react" | "angular" | "none";

/**
 * Task 6.2a — BB template choices shown in the picker step.
 * shortName + version pinned to match published NuGet packages (verified 2026-05-16).
 * When bumping versions, also update BB_TEMPLATE_PACKAGES in src/scaffold/init-new.ts.
 */
export const BB_TEMPLATE_OPTIONS: ReadonlyArray<{ label: string; desc: string; info: BBTemplateInfo }> = [
  {
    label: "BaseTemplate",
    desc: "Clean/Onion Architecture starter",
    info: { shortName: "mr-base-sln", nugetId: "Muonroi.BaseTemplate", version: "1.0.0-alpha.3" },
  },
  {
    label: "Modular",
    desc: "Modular Monolith",
    info: { shortName: "mr-mod-sln", nugetId: "Muonroi.Modular.Template", version: "1.10.0" },
  },
  {
    label: "Microservices",
    desc: "Microservices + YARP Gateway",
    info: { shortName: "mr-micro-sln", nugetId: "Muonroi.Microservices.Template", version: "1.10.0" },
  },
];

export interface InitNewFormState {
  step:
    | "name"
    | "fe-stack"
    | "designing"
    | "design-preview"
    | "bb-template"
    | "template-prompt"
    | "template-installing"
    | "running"
    | "done"
    | "error";
  /** Current text in the project name input. */
  nameInput: string;
  /** Validation error for name input. */
  nameError: string | null;
  /** Selected FE stack index (0=react, 1=angular, 2=none). */
  feStackIndex: number;
  /** Task 6.2a — selected BB template index. */
  bbTemplateIndex: number;
  /**
   * Task 6.2a — EE-recommended template index (for "⭐ recommended" badge).
   * null if no EE recommendation available.
   */
  eeRecommendedTemplateIndex: number | null;
  /** Output from scaffolder — project dir or error message. */
  resultMessage: string | null;
  /** Task 6.6 — template name shown post-scaffold. */
  scaffoldedTemplate?: string;
  /** Task 6.6 — coverage status shown post-scaffold. */
  scaffoldedCoverage?: "full" | "partial";
  /** Plan 23-02 — /ideal intent captured at form open. Empty string → manual menu fallback. */
  intent: string;
  /** Plan 23-02 — EE design result; null while loading or on failure. */
  bbDesign: BBDesign | null;
  /** Plan 23-02 — Whether to allow commercial packages in design re-runs. */
  allowCommercial: boolean;
  /** Plan 23-02 — Per-package on/off toggles, aligned with bbDesign.packageIds order. */
  packageToggles: boolean[];
  /** Plan 23-02 — Cursor position in design-preview package list. */
  designCursor: number;
  /** Plan 23-02 — Stored when design fails or times out — surfaced for user feedback. */
  designError: string | null;
  /** Progress line shown during `step: "running"` so the user knows the CLI is still working. */
  progressMessage?: string | null;
  /**
   * Plan 23-fix — when scaffold detects a missing BB template, the prompt step
   * shows this info and waits for user choice (install / manual / cancel).
   * The selectedIndex tracks ↑↓ cursor within the prompt's option list.
   */
  templatePromptInfo?: { shortName: string; nugetId: string; version: string } | null;
  templatePromptIndex?: number;
  /** Plan 23-fix — progress text for `step: "template-installing"` spinner. */
  templateInstallProgress?: string | null;
  /**
   * Plan 23-fix — when true, the `error` step shows a Retry option that
   * re-runs the scaffold with the previously-submitted inputs (no debate
   * re-run). Set when scaffold inputs are persisted in the parent ref.
   */
  errorRetryable?: boolean;
  /**
   * Scaffold-checkpoint integration — inputs captured at submit time so the
   * Retry handler (R key on error step) can replay initNewProject() without
   * walking back through the form. Mirrors ScaffoldCheckpoint["inputs"].
   */
  replayInputs?: {
    projectName: string;
    feStack: FeStack;
    bbTemplate?: BBTemplateInfo;
    eePackages?: string[];
    commercial?: boolean;
  };
  /** Loop-driver run id (or session id fallback) used as checkpoint key. */
  checkpointRunId?: string;
}

export const FE_STACK_OPTIONS: { label: string; value: FeStack; desc: string }[] = [
  { label: "React", value: "react", desc: "Vite + React + @muonroi/agent-harness-react" },
  { label: "Angular", value: "angular", desc: "Angular standalone + @muonroi/agent-harness-angular" },
  { label: "None", value: "none", desc: "Skip client — backend only" },
];

export function initialInitNewFormState(intent: string = ""): InitNewFormState {
  return {
    step: "name",
    nameInput: "",
    nameError: null,
    feStackIndex: 0, // default: react
    bbTemplateIndex: 0, // default: BaseTemplate
    eeRecommendedTemplateIndex: null,
    resultMessage: null,
    intent,
    bbDesign: null,
    allowCommercial: false,
    packageToggles: [],
    designCursor: 0,
    designError: null,
  };
}

export interface InitNewFormCardProps {
  state: InitNewFormState;
  terminalCols: number;
  theme: Theme;
}

const MAX_CARD_COLS = 90;
const FALLBACK_THRESHOLD = 60;

export function InitNewFormCard({ state, terminalCols, theme: t }: InitNewFormCardProps) {
  const fallback = terminalCols < FALLBACK_THRESHOLD;
  const width = fallback ? terminalCols : Math.min(terminalCols - 2, MAX_CARD_COLS);

  return (
    <Semantic id="init-new-form" role="dialog" name="Init new project">
      <box flexDirection="column" marginBottom={1}>
        <box
          width={width}
          borderStyle="single"
          borderColor={state.step === "error" ? t.initFormError : t.initFormBorder}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={t.initFormTitle} attributes={1}>
            Init new project
          </text>

          {/* Step 1: project name */}
          {(state.step === "name" ||
            state.step === "fe-stack" ||
            state.step === "bb-template" ||
            state.step === "designing" ||
            state.step === "design-preview") && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormLabel}>Project name:</text>
              <box flexDirection="row" marginTop={0}>
                <text fg={t.initFormInput}>
                  {state.step === "name" ? `> ${state.nameInput}_` : `  ${state.nameInput}`}
                </text>
              </box>
              {state.nameError && (
                <text fg={t.initFormError} marginTop={0}>
                  ✗ {state.nameError}
                </text>
              )}
            </box>
          )}

          {/* Step 2: FE stack picker */}
          {state.step === "fe-stack" && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormLabel}>Frontend stack:</text>
              {FE_STACK_OPTIONS.map((opt, i) => (
                <Semantic
                  key={opt.value}
                  id={`init-fe-option-${opt.value}`}
                  role="listitem"
                  name={opt.label}
                  selected={i === state.feStackIndex || undefined}
                >
                  <box flexDirection="row">
                    <text fg={i === state.feStackIndex ? t.initFormOptionSelected : t.initFormOptionDefault}>
                      {i === state.feStackIndex ? "▶ " : "  "}
                      {opt.label}
                    </text>
                    <text fg={t.initFormHint}> — {opt.desc}</text>
                  </box>
                </Semantic>
              ))}
            </box>
          )}

          {/* Step 3: BB template picker (task 6.2a) */}
          {state.step === "bb-template" && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormLabel}>Backend template:</text>
              {BB_TEMPLATE_OPTIONS.map((opt, i) => {
                const isSelected = i === state.bbTemplateIndex;
                const isRecommended = i === state.eeRecommendedTemplateIndex;
                return (
                  <Semantic
                    key={opt.info.shortName}
                    id={`init-bb-option-${opt.info.shortName}`}
                    role="listitem"
                    name={opt.label}
                    selected={isSelected || undefined}
                  >
                    <box flexDirection="row">
                      <text fg={isSelected ? t.initFormOptionSelected : t.initFormOptionDefault}>
                        {isSelected ? "▶ " : "  "}
                        {opt.label}
                      </text>
                      <text fg={t.initFormHint}> — {opt.desc}</text>
                      {isRecommended && <text fg={t.initFormSuccess}> ⭐ recommended</text>}
                    </box>
                  </Semantic>
                );
              })}
            </box>
          )}

          {/* Plan 23-02 — EE designing (spinner) */}
          {state.step === "designing" && (
            // biome-ignore lint/a11y/useValidAriaRole: statusbar is a valid harness Role; not a DOM element
            <Semantic id="init-designing" role="statusbar" name="EE designing">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormLabel}>EE designing BB packages for: {state.intent || "(no intent)"}</text>
                <text fg={t.initFormHint}>Esc to skip → manual template menu</text>
              </box>
            </Semantic>
          )}

          {/* Plan 23-02 — EE design preview */}
          {state.step === "design-preview" && state.bbDesign && (
            // biome-ignore lint/a11y/useValidAriaRole: harness Role union, not a DOM element
            <Semantic id="init-design-preview" role="region" name="EE design preview">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormLabel}>
                  Template: {state.bbDesign.template.shortName} ({state.bbDesign.template.nugetId}@
                  {state.bbDesign.template.version})
                </text>
                <text
                  fg={
                    state.bbDesign.confidence >= 0.6
                      ? t.initFormSuccess
                      : state.bbDesign.confidence >= 0.4
                        ? t.initFormOptionSelected
                        : t.initFormError
                  }
                >
                  Confidence: {Math.round(state.bbDesign.confidence * 100)}%
                </text>
                {state.bbDesign.rationale && (
                  <text fg={t.initFormHint}>
                    {state.bbDesign.rationale.length > 200
                      ? `${state.bbDesign.rationale.slice(0, 197)}…`
                      : state.bbDesign.rationale}
                  </text>
                )}

                {/* biome-ignore lint/a11y/useValidAriaRole: harness Role union, not a DOM element */}
                <Semantic id="init-design-packages" role="listbox" name="Designed OSS packages">
                  <box flexDirection="column" marginTop={1}>
                    <text fg={t.initFormLabel}>Packages (OSS):</text>
                    {state.bbDesign.packageIds.map((pkgId, i) => {
                      const isCursor = i === state.designCursor;
                      const isOn = state.packageToggles[i] ?? true;
                      return (
                        <Semantic
                          key={pkgId}
                          id={`design-pkg-${i}`}
                          role="listitem"
                          name={pkgId}
                          selected={isCursor || undefined}
                        >
                          <box flexDirection="row">
                            <text fg={isCursor ? t.initFormOptionSelected : t.initFormOptionDefault}>
                              {isCursor ? "▶ " : "  "}
                              {isOn ? "[x] " : "[ ] "}
                              {pkgId}
                            </text>
                          </box>
                        </Semantic>
                      );
                    })}
                  </box>
                </Semantic>

                {state.bbDesign.commercialBlocked.length > 0 && (
                  <Semantic
                    id="init-design-commercial"
                    role="listbox"
                    name={`Commercial blocked: ${state.bbDesign.commercialBlocked.join(", ")}`}
                  >
                    <box flexDirection="column" marginTop={1}>
                      <text fg={t.initFormHint}>Commercial (need --commercial flag):</text>
                      {state.bbDesign.commercialBlocked.map((pkgId) => (
                        <Semantic key={pkgId} id={`design-commercial-${pkgId}`} role="listitem" name={pkgId}>
                          <text fg={t.initFormHint}>
                            {"  · "}
                            {pkgId}
                          </text>
                        </Semantic>
                      ))}
                    </box>
                  </Semantic>
                )}

                {state.bbDesign.behavioralHints.length > 0 && (
                  <box flexDirection="column" marginTop={1}>
                    <text fg={t.initFormHint}>Hints:</text>
                    {state.bbDesign.behavioralHints.map((h, i) => (
                      <text key={i} fg={t.initFormHint}>
                        {"  · "}
                        {h.length > 120 ? `${h.slice(0, 117)}…` : h}
                      </text>
                    ))}
                  </box>
                )}
              </box>
            </Semantic>
          )}

          {/* Plan 23-02 — Design error fallback hint */}
          {state.step === "design-preview" && !state.bbDesign && state.designError && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormError}>EE design failed: {state.designError}</text>
              <text fg={t.initFormHint}>Esc to use manual menu</text>
            </box>
          )}

          {/* Plan 23-fix — Template-missing prompt */}
          {state.step === "template-prompt" && state.templatePromptInfo && (
            // biome-ignore lint/a11y/useValidAriaRole: harness Role union, not a DOM element
            <Semantic id="init-template-prompt" role="dialog" name="Template install prompt" isModal>
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormLabel} attributes={1}>
                  ⚠ Backend template chưa cài
                </text>
                <text fg={t.initFormHint} marginTop={0}>
                  {state.templatePromptInfo.nugetId}@{state.templatePromptInfo.version}
                </text>
                {(["install", "manual", "cancel"] as const).map((id, i) => {
                  const labels = {
                    install: "Cài tự động (dotnet new install)",
                    manual: "Tôi sẽ tự cài — Continue sau khi xong",
                    cancel: "Huỷ scaffold",
                  } as const;
                  const isSelected = i === (state.templatePromptIndex ?? 0);
                  return (
                    <Semantic
                      key={id}
                      id={`init-template-option-${id}`}
                      role="listitem"
                      name={labels[id]}
                      selected={isSelected || undefined}
                    >
                      <text fg={isSelected ? t.initFormOptionSelected : t.initFormOptionDefault}>
                        {isSelected ? "▶ " : "  "}
                        {labels[id]}
                      </text>
                    </Semantic>
                  );
                })}
              </box>
            </Semantic>
          )}

          {/* Plan 23-fix — Template installing spinner */}
          {state.step === "template-installing" && (
            // biome-ignore lint/a11y/useValidAriaRole: statusbar is a valid harness Role; not a DOM element
            <Semantic id="init-template-installing" role="statusbar" name="Installing template">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormLabel}>Installing template…</text>
                <text fg={t.initFormHint}>{state.templateInstallProgress ?? "dotnet new install in progress"}</text>
              </box>
            </Semantic>
          )}

          {/* Running state */}
          {state.step === "running" && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormLabel}>Scaffolding project "{state.nameInput}"…</text>
              <text fg={t.initFormHint}>{state.progressMessage ?? "Running dotnet new + applying BB ecosystem…"}</text>
            </box>
          )}

          {/* Done state — task 6.6: show template + coverage */}
          {state.step === "done" && (
            // biome-ignore lint/a11y/useValidAriaRole: statusbar is a valid harness Role; not a DOM element
            <Semantic id="init-new-result" role="statusbar" name="Scaffold complete">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormSuccess} attributes={1}>
                  ✓ Project scaffolded successfully!
                </text>
                {state.scaffoldedTemplate && <text fg={t.initFormLabel}>Template: {state.scaffoldedTemplate}</text>}
                {state.scaffoldedCoverage && (
                  <text fg={state.scaffoldedCoverage === "full" ? t.initFormSuccess : t.initFormHint}>
                    Coverage: {state.scaffoldedCoverage}
                  </text>
                )}
                {state.resultMessage && <text fg={t.initFormLabel}>{state.resultMessage}</text>}
              </box>
            </Semantic>
          )}

          {/* Error state */}
          {state.step === "error" && (
            // biome-ignore lint/a11y/useValidAriaRole: statusbar is a valid harness Role; not a DOM element
            <Semantic id="init-new-result" role="statusbar" name="Scaffold failed">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormError} attributes={1}>
                  ✗ Scaffold failed
                </text>
                {state.resultMessage && <text fg={t.initFormError}>{state.resultMessage}</text>}
                {state.errorRetryable && (
                  <Semantic id="init-error-retry-hint" role="listitem" name="Retry available">
                    <text fg={t.initFormSuccess} marginTop={1}>
                      ↻ Press R to retry (inputs preserved — không debate lại)
                    </text>
                  </Semantic>
                )}
              </box>
            </Semantic>
          )}

          {/* Hint line */}
          <text fg={t.initFormHint} marginTop={1}>
            {state.step === "name" && "Type project name · Enter next · Esc cancel"}
            {state.step === "fe-stack" && "↑↓ select · Enter next · Esc back"}
            {state.step === "bb-template" && "↑↓ select · Enter confirm · Esc back"}
            {state.step === "designing" && "EE designing… · Esc skip to manual"}
            {state.step === "design-preview" && "Space toggle · c allow-commercial · Enter confirm · Esc manual"}
            {state.step === "template-prompt" && "↑↓ select · Enter confirm · Esc cancel"}
            {state.step === "template-installing" && "Please wait…"}
            {state.step === "running" && "Please wait…"}
            {state.step === "done" && "Esc / Enter dismiss"}
            {state.step === "error" && (state.errorRetryable ? "R retry · Esc / Enter dismiss" : "Esc / Enter dismiss")}
          </text>
        </box>
      </box>
    </Semantic>
  );
}
