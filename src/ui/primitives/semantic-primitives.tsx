/**
 * src/ui/primitives/semantic-primitives.tsx
 *
 * Role-fixed semantic primitives. Compose these instead of hand-writing
 * `<Semantic role="...">` in feature code. Two things they buy you:
 *
 *   1. The `role` is fixed per component, so it can't be typo'd or drift, and
 *      TypeScript enforces the right props per role.
 *   2. Interactive state is passed as plain booleans (`focused`, `selected`,
 *      `disabled`, `hidden`) and mirrored to the Semantic node's `true|undefined`
 *      flags automatically — no more `focus={cond ? true : undefined}` written
 *      by hand at every call site (the #1 source of harness/state drift).
 *
 * Feature authors should reach for these first; a raw `<Semantic>` is only for
 * genuinely bespoke roles not covered here (or a namespaced `x-*` role).
 *
 * These are invisible wrappers (like `<Semantic>` itself): zero OpenTUI element,
 * zero runtime cost when the agent runtime is unset.
 */

import type { Role } from "@muonroi/agent-harness-core/protocol";
import { Semantic } from "@muonroi/agent-harness-opentui";
import type * as React from "react";

/** Coerce a boolean into the Semantic flag shape (`true` present, else absent). */
function flag(value: boolean | undefined): true | undefined {
  return value ? true : undefined;
}

/**
 * Common props shared by every primitive. `focused`/`selected`/`disabled`/
 * `hidden` are plain booleans here (not `true`-literal) and are mirrored to the
 * underlying Semantic flags.
 */
export interface BlockProps {
  id: string;
  name?: string;
  value?: string;
  state?: string;
  focused?: boolean;
  selected?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  props?: Record<string, unknown>;
  children?: React.ReactNode;
}

/**
 * Internal base. Renders a `<Semantic>` with a fixed `role`, mapping the plain
 * boolean props to the flag shape. `isModal` is passed through for the roles
 * that support it (dialog/menu).
 */
function Block({
  role,
  isModal,
  id,
  name,
  value,
  state,
  focused,
  selected,
  disabled,
  hidden,
  props,
  children,
}: BlockProps & { role: Role; isModal?: boolean }) {
  return (
    <Semantic
      id={id}
      role={role}
      name={name}
      value={value}
      state={state}
      focus={flag(focused)}
      selected={flag(selected)}
      disabled={flag(disabled)}
      hidden={flag(hidden)}
      isModal={flag(isModal)}
      props={props}
    >
      {children}
    </Semantic>
  );
}

// ---------------------------------------------------------------------------
// Role-fixed primitives
// ---------------------------------------------------------------------------

/** A modal dialog. `isModal` defaults to true (pass `isModal={false}` to opt out). */
export function Dialog({ isModal = true, ...rest }: BlockProps & { isModal?: boolean }) {
  return <Block role="dialog" isModal={isModal} {...rest} />;
}

/** A generic grouping region / panel. */
export function Region(props: BlockProps) {
  return <Block role="region" {...props} />;
}

/** A titled content panel (IDE-style). */
export function Panel(props: BlockProps) {
  return <Block role="panel" {...props} />;
}

/** A single-line or multi-line text input. Pass `value` + `focused`. */
export function TextBox(props: BlockProps) {
  return <Block role="textbox" {...props} />;
}

/** A pressable button. Pass `disabled`/`focused` as booleans. */
export function Button(props: BlockProps) {
  return <Block role="button" {...props} />;
}

/** A toggle. Reflect checked state via `selected`. */
export function Checkbox(props: BlockProps) {
  return <Block role="checkbox" {...props} />;
}

/** A scrollable list container. */
export function ListBox(props: BlockProps) {
  return <Block role="listbox" {...props} />;
}

/** A single list row. Reflect highlight via `selected`. */
export function ListItem(props: BlockProps) {
  return <Block role="listitem" {...props} />;
}

/** A command / context menu. `isModal` defaults to true. */
export function Menu({ isModal = true, ...rest }: BlockProps & { isModal?: boolean }) {
  return <Block role="menu" isModal={isModal} {...rest} />;
}

/** A single menu entry. */
export function MenuItem(props: BlockProps) {
  return <Block role="menuitem" {...props} />;
}

/** A transient notification. */
export function Toast(props: BlockProps) {
  return <Block role="toast" {...props} />;
}

/** The persistent status bar. */
export function StatusBar(props: BlockProps) {
  return <Block role="statusbar" {...props} />;
}

/** A determinate/indeterminate progress indicator. Put `0..1` in `value`. */
export function ProgressBar(props: BlockProps) {
  return <Block role="progressbar" {...props} />;
}

/** A scrollback / message log. */
export function Log(props: BlockProps) {
  return <Block role="log" {...props} />;
}

/**
 * Escape hatch for a namespaced custom role not covered above. `role` MUST start
 * with `x-` (enforced by the `Role` type). Prefer a named primitive when one fits.
 */
export function CustomBlock({ role, ...rest }: BlockProps & { role: `x-${string}` }) {
  return <Block role={role} {...rest} />;
}
