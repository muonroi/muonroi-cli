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

import type { BBTemplateInfo } from "../../scaffold/init-new.js";
import { Semantic } from "@muonroi/agent-harness-opentui";
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
  step: "name" | "fe-stack" | "bb-template" | "running" | "done" | "error";
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
}

export const FE_STACK_OPTIONS: { label: string; value: FeStack; desc: string }[] = [
  { label: "React", value: "react", desc: "Vite + React + @muonroi/agent-harness-react" },
  { label: "Angular", value: "angular", desc: "Angular standalone + @muonroi/agent-harness-angular" },
  { label: "None", value: "none", desc: "Skip client — backend only" },
];

export function initialInitNewFormState(): InitNewFormState {
  return {
    step: "name",
    nameInput: "",
    nameError: null,
    feStackIndex: 0, // default: react
    bbTemplateIndex: 0, // default: BaseTemplate
    eeRecommendedTemplateIndex: null,
    resultMessage: null,
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
          {(state.step === "name" || state.step === "fe-stack" || state.step === "bb-template") && (
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

          {/* Running state */}
          {state.step === "running" && (
            <box flexDirection="column" marginTop={1}>
              <text fg={t.initFormLabel}>Scaffolding project "{state.nameInput}"…</text>
              <text fg={t.initFormHint}>Running dotnet new + applying BB ecosystem…</text>
            </box>
          )}

          {/* Done state — task 6.6: show template + coverage */}
          {state.step === "done" && (
            <Semantic id="init-new-result" role="statusbar" name="Scaffold complete">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormSuccess} attributes={1}>
                  ✓ Project scaffolded successfully!
                </text>
                {state.scaffoldedTemplate && (
                  <text fg={t.initFormLabel}>Template: {state.scaffoldedTemplate}</text>
                )}
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
            <Semantic id="init-new-result" role="statusbar" name="Scaffold failed">
              <box flexDirection="column" marginTop={1}>
                <text fg={t.initFormError} attributes={1}>
                  ✗ Scaffold failed
                </text>
                {state.resultMessage && <text fg={t.initFormError}>{state.resultMessage}</text>}
              </box>
            </Semantic>
          )}

          {/* Hint line */}
          <text fg={t.initFormHint} marginTop={1}>
            {state.step === "name" && "Type project name · Enter next · Esc cancel"}
            {state.step === "fe-stack" && "↑↓ select · Enter next · Esc back"}
            {state.step === "bb-template" && "↑↓ select · Enter confirm · Esc back"}
            {state.step === "running" && "Please wait…"}
            {(state.step === "done" || state.step === "error") && "Esc / Enter dismiss"}
          </text>
        </box>
      </box>
    </Semantic>
  );
}
