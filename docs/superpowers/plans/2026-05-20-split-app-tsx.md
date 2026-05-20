# Split `src/ui/app.tsx` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/ui/app.tsx` (9,368 lines) thành các module nhỏ, có boundary rõ ràng, dễ bảo trì — không thay đổi bất kỳ behavior nào.

**Architecture:** Pure refactor theo nguyên tắc: extract → re-export → verify tsc → commit. Mỗi task độc lập và reversible. Thứ tự: types/constants → leaf utils → leaf components → modal components → message rendering → input components → hooks → handlers. `app.tsx` cuối cùng chỉ còn ~500 dòng (App shell + composition).

**Tech Stack:** TypeScript, React (OpenTUI), Bun, Vitest

---

## Mục tiêu file structure sau khi hoàn thành

```
src/ui/
├── app.tsx                              (~500 dòng — App shell + composition)
├── types.ts                             (tất cả interfaces/types)
├── constants.ts                         (HERO_ROWS, SANDBOX_ROWS, WALLET_ROWS, MCP_FIELDS)
├── utils/
│   ├── color.ts                         (withAlpha)
│   ├── text.ts                          (formatTokenCount, trunc, truncateLine, truncateBlock, compactTaskLabel, sanitizeContent)
│   ├── tools.ts                         (describeMcpFsTool, toolArgs, tryParseArg, toolLabel)
│   ├── modal.ts                         (bottomAlignedModalTop, isEscapeKey)
│   └── format.ts                        (formatScheduleDetails, formatLspSeverity, formatAnswerForLog, buildAssistantEntry, buildToolResultEntry)
├── components/
│   ├── hero-logo.tsx                    (HeroLogo)
│   ├── session-header.tsx               (SessionHeader, ContextMeter)
│   ├── slash-inline-menu.tsx            (SlashInlineMenu)
│   ├── prompt-box.tsx                   (PromptBox, PromptModeLabel, PromptLoadingBoxes, promptLoadingCellGlyph, promptLoadingCellColor)
│   ├── copy-flash-banner.tsx            (CopyFlashBanner)
│   ├── message-view.tsx                 (UserMessageContent, MessageView)
│   ├── structured-response-view.tsx     (StructuredResponseView)
│   ├── diff-view.tsx                    (parsePatch, renderHighlighted, DiffView, ReadFilePreviewView)
│   ├── lsp-views.tsx                    (LspResultView, LspDiagnosticsView, formatLspSeverity)
│   ├── tool-result-views.tsx            (SubagentTaskLine, DelegationTaskLine, LoadingSpinner, SubagentActivity, TaskResultView, DelegationResultView, DelegationListView, parseDelegationList, BackgroundProcessLine, formatScheduleDetails, ProcessLogsView, truncateBlock, ToolTextOutputView)
│   └── media-views.tsx                  (openMediaFile, MediaAutoOpenView, MediaToolResultView)
├── modals/
│   ├── api-key-modal.tsx                (ApiKeyModal)
│   ├── update-modal.tsx                 (UpdateModal)
│   ├── connect-modal.tsx                (ConnectModal, TelegramTokenModal, TelegramPairModal)
│   ├── model-picker-modal.tsx           (sortModelsByTier, groupModelsByTier, TierGroup, ModelPickerModal)
│   ├── sandbox-picker-modal.tsx         (SandboxPickerModal)
│   └── wallet-picker-modal.tsx          (PaymentApprovalPanel, WalletPickerModal)
└── hooks/
    ├── use-model-picker.ts              (model picker state + handlers)
    ├── use-mcp-editor.ts                (MCP modal/editor state + handlers)
    └── use-agent-editor.ts              (subagent modal/editor state + handlers)
```

---

## Quy tắc chung cho mọi task

1. **KHÔNG thay đổi logic** — chỉ move code, fix imports.
2. Sau mỗi task: `bunx tsc --noEmit` → 0 errors.
3. Mỗi task là một commit riêng.
4. Nếu có circular import: thêm một `types.ts` intermediate thay vì merge file lại.

---

## Task 1: Extract Types & Interfaces

**Files:**
- Create: `src/ui/types.ts`
- Modify: `src/ui/app.tsx` (remove extracted definitions, add import)

- [ ] **Step 1: Tạo `src/ui/types.ts`** — cut các interface/type sau từ `app.tsx`:

```ts
// src/ui/types.ts
export type TelegramBridgeHandle = Record<string, never>; // lines 170 (stub)

export interface ContextStats {
  usedTokens: number;
  maxTokens: number;
  usedPercent: number;
  windowName: string;
  costUsd?: number;
}

export interface PasteBlock {
  id: string;
  label: string;
  content: string;
  imagePath?: string;
  imageData?: string;
  mimeType?: string;
}

export type FileMentionBlock = { id: string; path: string };

export interface QueuedMessage {
  text: string;
  pasteBlocks: PasteBlock[];
}

export interface SandboxRow {
  id: string;
  label: string;
  description: string;
  kind: "toggle" | "action";
  value?: boolean;
  action?: () => void;
}

export interface WalletDisplayInfo {
  balance: string;
  currency: string;
  address: string;
  provider: string;
}

export interface WalletRow {
  id: string;
  label: string;
  description: string;
  kind: "toggle" | "action" | "info";
  value?: boolean;
  action?: () => void;
}

export interface AppStartupConfig {
  model: string;
  sandboxMode: string;
  apiKey?: string;
  profile?: string;
  reasoningEffort?: string;
  maxTokens?: number;
  outputFormat?: string;
  systemPrompt?: string;
  customAgent?: string;
  noHistory?: boolean;
  workingDir?: string;
}

export interface AppProps {
  agent: import("../orchestrator/coordinator.js").Coordinator;
  startupConfig: AppStartupConfig;
  initialMessage?: string;
  onExit?: () => void;
}

export interface ActiveTurnState {
  runId: string;
  abortController: AbortController;
  startedAt: number;
  model: string;
  messageIndex: number;
}

export interface DiffRow {
  kind: "add" | "remove" | "context" | "header";
  content: string;
  lineNo?: number;
}

export interface TierGroup {
  tier: string;
  models: import("../models/registry.js").ModelInfo[];
}
```

- [ ] **Step 2: Trong `app.tsx`**, xóa các interface đã extract và thêm vào đầu file:

```ts
import type { ActiveTurnState, AppProps, AppStartupConfig, ContextStats, FileMentionBlock, PasteBlock, QueuedMessage, SandboxRow, TelegramBridgeHandle, WalletDisplayInfo, WalletRow } from "./types.js";
```

- [ ] **Step 3: Verify**

```powershell
cd D:\Personal\Core\muonroi-cli && bunx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```powershell
git add src/ui/types.ts src/ui/app.tsx
git commit -m "refactor(ui): extract types/interfaces to src/ui/types.ts"
```

---

## Task 2: Extract Constants

**Files:**
- Create: `src/ui/constants.ts`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/constants.ts`** — cut các constant sau từ `app.tsx`:

```ts
// src/ui/constants.ts
// HERO_ROWS (lines 370-430): animated logo data
export const HERO_ROWS = [ /* paste exact content from app.tsx lines 370-430 */ ];

// SANDBOX_ROWS (lines 491-605): sandbox settings definitions
export const SANDBOX_ROWS: import("./types.js").SandboxRow[] = [ /* paste from app.tsx */ ];

// WALLET_ROWS (lines 711-762): wallet settings definitions  
export const WALLET_ROWS: import("./types.js").WalletRow[] = [ /* paste from app.tsx */ ];

// MCP config field constants (lines 810-811)
export const MCP_REMOTE_FIELDS = [ /* paste from app.tsx */ ];
export const MCP_STDIO_FIELDS = [ /* paste from app.tsx */ ];
```

- [ ] **Step 2: Trong `app.tsx`**, xóa các constant đã extract và thêm import:

```ts
import { HERO_ROWS, MCP_REMOTE_FIELDS, MCP_STDIO_FIELDS, SANDBOX_ROWS, WALLET_ROWS } from "./constants.js";
```

- [ ] **Step 3: Verify**

```powershell
bunx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 4: Commit**

```powershell
git add src/ui/constants.ts src/ui/app.tsx
git commit -m "refactor(ui): extract constants to src/ui/constants.ts"
```

---

## Task 3: Extract Utility Functions

**Files:**
- Create: `src/ui/utils/color.ts`, `src/ui/utils/text.ts`, `src/ui/utils/tools.ts`, `src/ui/utils/modal.ts`, `src/ui/utils/format.ts`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/utils/color.ts`** (lines 7119-7138):

```ts
// src/ui/utils/color.ts
export function withAlpha(color: string, alpha: number): string {
  // paste exact implementation from app.tsx lines 7119-7138
}
```

- [ ] **Step 2: Tạo `src/ui/utils/text.ts`**:

```ts
// src/ui/utils/text.ts
export function formatTokenCount(n: number): string {
  // paste from lines 6760-6764
}
export function trunc(s: string, max: number): string {
  // paste from lines 9363-9365
}
export function truncateLine(s: string, max: number): string {
  // paste from lines 9366-9368
}
export function truncateBlock(text: string, maxLines: number): string {
  // paste from lines 8303-8308
}
export function compactTaskLabel(label: string): string {
  // paste from lines 9358-9362
}
export function sanitizeContent(content: string): string {
  // paste from lines 9343-9347
}
```

- [ ] **Step 3: Tạo `src/ui/utils/tools.ts`**:

```ts
// src/ui/utils/tools.ts
export function describeMcpFsTool(name: string): string {
  // paste from lines 9253-9274
}
export function toolArgs(args: Record<string, unknown>): string {
  // paste from lines 9275-9303
}
export function tryParseArg(args: Record<string, unknown>, key: string): string | undefined {
  // paste from lines 9304-9311
}
export function toolLabel(toolName: string, args: Record<string, unknown>): string {
  // paste from lines 9312-9342
}
```

- [ ] **Step 4: Tạo `src/ui/utils/modal.ts`**:

```ts
// src/ui/utils/modal.ts
export function bottomAlignedModalTop(termHeight: number, modalHeight: number): number {
  // paste from lines 8385-8390
}
export function isEscapeKey(key: string): boolean {
  // paste from lines 9238-9252
}
```

- [ ] **Step 5: Tạo `src/ui/utils/format.ts`**:

```ts
// src/ui/utils/format.ts
export function formatScheduleDetails(schedule: unknown): string {
  // paste from lines 8261-8280
}
export function formatLspSeverity(severity: number): string {
  // paste from lines 8058-8072
}
// buildAssistantEntry, buildToolResultEntry, formatAnswerForLog (lines 259-327)
export function buildAssistantEntry(/* ... */): import("../types.js").ChatEntry {
  // paste exact from app.tsx
}
export function buildToolResultEntry(/* ... */): import("../types.js").ChatEntry {
  // paste exact from app.tsx
}
export function formatAnswerForLog(/* ... */): string {
  // paste exact from app.tsx
}
```

- [ ] **Step 6: Trong `app.tsx`**, xóa các function đã extract và thêm imports:

```ts
import { withAlpha } from "./utils/color.js";
import { compactTaskLabel, formatTokenCount, sanitizeContent, trunc, truncateBlock, truncateLine } from "./utils/text.js";
import { describeMcpFsTool, toolArgs, toolLabel, tryParseArg } from "./utils/tools.js";
import { bottomAlignedModalTop, isEscapeKey } from "./utils/modal.js";
import { buildAssistantEntry, buildToolResultEntry, formatAnswerForLog, formatLspSeverity, formatScheduleDetails } from "./utils/format.js";
```

- [ ] **Step 7: Verify**

```powershell
bunx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 8: Commit**

```powershell
git add src/ui/utils/ src/ui/app.tsx
git commit -m "refactor(ui): extract utility functions to src/ui/utils/"
```

---

## Task 4: Extract Hero Logo Component

**Files:**
- Create: `src/ui/components/hero-logo.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/components/hero-logo.tsx`** — cut `HeroLogo` (lines 432-489) và `Star`/`Row` types:

```tsx
// src/ui/components/hero-logo.tsx
import React from "@opentui/react";
import { HERO_ROWS } from "../constants.js";

interface Star { x: number; y: number; opacity: number }
interface Row { cells: string[]; color: string }

export function HeroLogo(): React.JSX.Element {
  // paste exact implementation from app.tsx lines 432-489
}
```

- [ ] **Step 2: Xóa `HeroLogo` khỏi `app.tsx`**, thêm import:

```ts
import { HeroLogo } from "./components/hero-logo.js";
```

- [ ] **Step 3: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/components/hero-logo.tsx src/ui/app.tsx
git commit -m "refactor(ui): extract HeroLogo to src/ui/components/hero-logo.tsx"
```

---

## Task 5: Extract Diff & Code Rendering Components

**Files:**
- Create: `src/ui/components/diff-view.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/components/diff-view.tsx`** — cut lines 7759-7980:

```tsx
// src/ui/components/diff-view.tsx
import React from "@opentui/react";
import type { DiffRow } from "../types.js";

export function parsePatch(patch: string): DiffRow[] {
  // paste from lines 7768-7808
}

export function renderHighlighted(code: string, lang?: string): React.JSX.Element {
  // paste from lines 7809-7826
}

export function DiffView({ patch, filename }: { patch: string; filename?: string }): React.JSX.Element {
  // paste from lines 7827-7915
}

export function ReadFilePreviewView({ content, filename }: { content: string; filename: string }): React.JSX.Element {
  // paste from lines 7916-7980
}
```

- [ ] **Step 2: Xóa khỏi `app.tsx`**, thêm import:

```ts
import { DiffView, parsePatch, ReadFilePreviewView, renderHighlighted } from "./components/diff-view.js";
```

- [ ] **Step 3: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/components/diff-view.tsx src/ui/app.tsx
git commit -m "refactor(ui): extract DiffView/ReadFilePreview to src/ui/components/diff-view.tsx"
```

---

## Task 6: Extract LSP Views

**Files:**
- Create: `src/ui/components/lsp-views.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/components/lsp-views.tsx`** — cut lines 7981-8072:

```tsx
// src/ui/components/lsp-views.tsx
import React from "@opentui/react";

export function LspResultView(/* props */): React.JSX.Element {
  // paste from lines 7981-8030
}

export function LspDiagnosticsView(/* props */): React.JSX.Element {
  // paste from lines 8031-8057
}

export function formatLspSeverity(severity: number): string {
  // paste from lines 8058-8072
}
```

- [ ] **Step 2: Xóa khỏi `app.tsx`**, thêm import:

```ts
import { LspDiagnosticsView, LspResultView } from "./components/lsp-views.js";
```

- [ ] **Step 3: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/components/lsp-views.tsx src/ui/app.tsx
git commit -m "refactor(ui): extract LspResultView/LspDiagnosticsView to src/ui/components/lsp-views.tsx"
```

---

## Task 7: Extract Tool Result Views

**Files:**
- Create: `src/ui/components/tool-result-views.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/components/tool-result-views.tsx`** — cut lines 8073-8321:

```tsx
// src/ui/components/tool-result-views.tsx
import React from "@opentui/react";

export function ShimmerText({ text }: { text: string }): React.JSX.Element {
  // paste from lines 8073-8085
}

export function InlineTool(/* props */): React.JSX.Element {
  // paste from lines 8086-8096
}

export function SubagentTaskLine(/* props */): React.JSX.Element {
  // paste from lines 8097-8117
}

export function DelegationTaskLine(/* props */): React.JSX.Element {
  // paste from lines 8118-8143
}

export function LoadingSpinner(): React.JSX.Element {
  // paste from lines 8144-8154
}

export function SubagentActivity(/* props */): React.JSX.Element {
  // paste from lines 8155-8165
}

export function TaskResultView(/* props */): React.JSX.Element {
  // paste from lines 8166-8183
}

export function DelegationResultView(/* props */): React.JSX.Element {
  // paste from lines 8184-8190
}

export function DelegationListView(/* props */): React.JSX.Element {
  // paste from lines 8191-8231
}

export function parseDelegationList(text: string): string[] {
  // paste from lines 8232-8242
}

export function BackgroundProcessLine(/* props */): React.JSX.Element {
  // paste from lines 8243-8260
}

export function ProcessLogsView(/* props */): React.JSX.Element {
  // paste from lines 8281-8302
}

export function ToolTextOutputView(/* props */): React.JSX.Element {
  // paste from lines 8309-8321
}
```

- [ ] **Step 2: Xóa khỏi `app.tsx`**, thêm import:

```ts
import { BackgroundProcessLine, DelegationListView, DelegationResultView, DelegationTaskLine, InlineTool, LoadingSpinner, parseDelegationList, ProcessLogsView, ShimmerText, SubagentActivity, SubagentTaskLine, TaskResultView, ToolTextOutputView } from "./components/tool-result-views.js";
```

- [ ] **Step 3: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/components/tool-result-views.tsx src/ui/app.tsx
git commit -m "refactor(ui): extract tool result views to src/ui/components/tool-result-views.tsx"
```

---

## Task 8: Extract Media Views

**Files:**
- Create: `src/ui/components/media-views.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/components/media-views.tsx`** — cut lines 8322-8384:

```tsx
// src/ui/components/media-views.tsx
import React from "@opentui/react";

export function openMediaFile(path: string): void {
  // paste from lines 8322-8328
}

export function MediaAutoOpenView(/* props */): React.JSX.Element {
  // paste from lines 8329-8350
}

export function MediaToolResultView(/* props */): React.JSX.Element {
  // paste from lines 8351-8384
}
```

- [ ] **Step 2: Xóa khỏi `app.tsx`**, thêm import:

```ts
import { MediaAutoOpenView, MediaToolResultView, openMediaFile } from "./components/media-views.js";
```

- [ ] **Step 3: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/components/media-views.tsx src/ui/app.tsx
git commit -m "refactor(ui): extract media views to src/ui/components/media-views.tsx"
```

---

## Task 9: Extract Modal Components

**Files:**
- Create: `src/ui/modals/api-key-modal.tsx`, `src/ui/modals/update-modal.tsx`, `src/ui/modals/connect-modal.tsx`, `src/ui/modals/model-picker-modal.tsx`, `src/ui/modals/sandbox-picker-modal.tsx`, `src/ui/modals/wallet-picker-modal.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/modals/api-key-modal.tsx`** — cut lines 7169-7259:

```tsx
// src/ui/modals/api-key-modal.tsx
import React from "@opentui/react";

export function ApiKeyModal(/* props */): React.JSX.Element {
  // paste exact from lines 7169-7259
}
```

- [ ] **Step 2: Tạo `src/ui/modals/update-modal.tsx`** — cut lines 8391-8455:

```tsx
// src/ui/modals/update-modal.tsx
import React from "@opentui/react";
import { bottomAlignedModalTop } from "../utils/modal.js";

export function UpdateModal(/* props */): React.JSX.Element {
  // paste from lines 8391-8455
}
```

- [ ] **Step 3: Tạo `src/ui/modals/connect-modal.tsx`** — cut lines 8456-8711:

```tsx
// src/ui/modals/connect-modal.tsx
import React from "@opentui/react";

export function ConnectModal(/* props */): React.JSX.Element {
  // paste from lines 8456-8536
}

export function TelegramTokenModal(/* props */): React.JSX.Element {
  // paste from lines 8537-8621
}

export function TelegramPairModal(/* props */): React.JSX.Element {
  // paste from lines 8622-8711
}
```

- [ ] **Step 4: Tạo `src/ui/modals/model-picker-modal.tsx`** — cut lines 8712-8959:

```tsx
// src/ui/modals/model-picker-modal.tsx
import React from "@opentui/react";
import type { TierGroup } from "../types.js";

export function sortModelsByTier(models: unknown[]): unknown[] {
  // paste from lines 8712-8721
}

export function groupModelsByTier(models: unknown[]): TierGroup[] {
  // paste from lines 8722-8733
}

export function ModelPickerModal(/* props */): React.JSX.Element {
  // paste from lines 8734-8959
}
```

- [ ] **Step 5: Tạo `src/ui/modals/sandbox-picker-modal.tsx`** — cut lines 8960-9054:

```tsx
// src/ui/modals/sandbox-picker-modal.tsx
import React from "@opentui/react";

export function SandboxPickerModal(/* props */): React.JSX.Element {
  // paste from lines 8960-9054
}
```

- [ ] **Step 6: Tạo `src/ui/modals/wallet-picker-modal.tsx`** — cut lines 9055-9237:

```tsx
// src/ui/modals/wallet-picker-modal.tsx
import React from "@opentui/react";

export function PaymentApprovalPanel(/* props */): React.JSX.Element {
  // paste from lines 9055-9155
}

export function WalletPickerModal(/* props */): React.JSX.Element {
  // paste from lines 9156-9237
}
```

- [ ] **Step 7: Trong `app.tsx`**, xóa các component và thêm imports:

```ts
import { ApiKeyModal } from "./modals/api-key-modal.js";
import { UpdateModal } from "./modals/update-modal.js";
import { ConnectModal, TelegramPairModal, TelegramTokenModal } from "./modals/connect-modal.js";
import { groupModelsByTier, ModelPickerModal, sortModelsByTier } from "./modals/model-picker-modal.js";
import { SandboxPickerModal } from "./modals/sandbox-picker-modal.js";
import { PaymentApprovalPanel, WalletPickerModal } from "./modals/wallet-picker-modal.js";
```

- [ ] **Step 8: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/modals/ src/ui/app.tsx
git commit -m "refactor(ui): extract modal components to src/ui/modals/"
```

---

## Task 10: Extract Message Rendering Components

**Files:**
- Create: `src/ui/components/message-view.tsx`, `src/ui/components/structured-response-view.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/components/structured-response-view.tsx`** — cut lines 7568-7757:

```tsx
// src/ui/components/structured-response-view.tsx
import React from "@opentui/react";

export function StructuredResponseView(/* props */): React.JSX.Element {
  // paste from lines 7568-7650
}
// Include any helper functions used only by StructuredResponseView
```

- [ ] **Step 2: Tạo `src/ui/components/message-view.tsx`** — cut lines 7260-7567:

```tsx
// src/ui/components/message-view.tsx
import React from "@opentui/react";
import { StructuredResponseView } from "./structured-response-view.js";
import { DiffView } from "./diff-view.js";
import { LspResultView, LspDiagnosticsView } from "./lsp-views.js";
import { ShimmerText, InlineTool, SubagentTaskLine, DelegationTaskLine, LoadingSpinner, SubagentActivity, TaskResultView, DelegationResultView, DelegationListView, BackgroundProcessLine, ProcessLogsView, ToolTextOutputView } from "./tool-result-views.js";
import { MediaToolResultView } from "./media-views.js";

export function UserMessageContent(/* props */): React.JSX.Element {
  // paste from lines 7260-7353
}

export function MessageView(/* props */): React.JSX.Element {
  // paste from lines 7354-7567
}
```

- [ ] **Step 3: Trong `app.tsx`**, xóa và thêm imports:

```ts
import { MessageView, UserMessageContent } from "./components/message-view.js";
import { StructuredResponseView } from "./components/structured-response-view.js";
```

- [ ] **Step 4: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/components/message-view.tsx src/ui/components/structured-response-view.tsx src/ui/app.tsx
git commit -m "refactor(ui): extract MessageView/StructuredResponseView to src/ui/components/"
```

---

## Task 11: Extract Input & Prompt Components

**Files:**
- Create: `src/ui/components/session-header.tsx`, `src/ui/components/slash-inline-menu.tsx`, `src/ui/components/prompt-box.tsx`, `src/ui/components/copy-flash-banner.tsx`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/components/session-header.tsx`** — cut lines 6705-6778:

```tsx
// src/ui/components/session-header.tsx
import React from "@opentui/react";
import type { ContextStats } from "../types.js";

export function SessionHeader(/* props */): React.JSX.Element {
  // paste from lines 6705-6751
}

export function ContextMeter({ stats }: { stats: ContextStats }): React.JSX.Element {
  // paste from lines 6766-6778
}
```

- [ ] **Step 2: Tạo `src/ui/components/slash-inline-menu.tsx`** — cut lines 6782-6830:

```tsx
// src/ui/components/slash-inline-menu.tsx
import React from "@opentui/react";

export function SlashInlineMenu(/* props */): React.JSX.Element {
  // paste from lines 6782-6830
}
```

- [ ] **Step 3: Tạo `src/ui/components/copy-flash-banner.tsx`** — cut lines 7139-7168:

```tsx
// src/ui/components/copy-flash-banner.tsx
import React from "@opentui/react";

export function CopyFlashBanner(/* props */): React.JSX.Element {
  // paste from lines 7139-7168
}
```

- [ ] **Step 4: Tạo `src/ui/components/prompt-box.tsx`** — cut lines 6832-7106:

```tsx
// src/ui/components/prompt-box.tsx
import React from "@opentui/react";
import { withAlpha } from "../utils/color.js";

export function promptLoadingCellGlyph(frame: number): string {
  // paste from lines 7107-7111
}

export function promptLoadingCellColor(frame: number): string {
  // paste from lines 7112-7118
}

export function PromptLoadingBoxes({ frame }: { frame: number }): React.JSX.Element {
  // paste from lines 7086-7106
}

export function PromptModeLabel({ mode }: { mode: string }): React.JSX.Element {
  // paste from lines 7066-7085
}

export function PromptBox(/* props */): React.JSX.Element {
  // paste from lines 6832-7065 (large component — includes internal state)
}
```

- [ ] **Step 5: Trong `app.tsx`**, xóa và thêm imports:

```ts
import { SessionHeader, ContextMeter } from "./components/session-header.js";
import { SlashInlineMenu } from "./components/slash-inline-menu.js";
import { CopyFlashBanner } from "./components/copy-flash-banner.js";
import { PromptBox, PromptModeLabel } from "./components/prompt-box.js";
```

- [ ] **Step 6: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/components/session-header.tsx src/ui/components/slash-inline-menu.tsx src/ui/components/prompt-box.tsx src/ui/components/copy-flash-banner.tsx src/ui/app.tsx
git commit -m "refactor(ui): extract prompt/input components to src/ui/components/"
```

---

## Task 12: Extract `useModelPicker` Hook

**Files:**
- Create: `src/ui/hooks/use-model-picker.ts`
- Modify: `src/ui/app.tsx`

Mục tiêu: gom toàn bộ state + handler liên quan đến model picker vào một custom hook.

- [ ] **Step 1: Identify model picker state** trong `app.tsx`:

Các state liên quan (trong App component):
- `model`, `setModel`
- `showModelPicker`, `setShowModelPicker`
- `modelPickerIndex`, `setModelPickerIndex`
- `modelSearchQuery`, `setModelSearchQuery`
- `disabledModels`, `setDisabledModels`
- `disabledProviders`, `setDisabledProviders`
- `reasoningEffortByModel`, `setReasoningEffortByModel`

Các handler liên quan: model filtering/selection logic trong `handleKey` và `handleCommand`.

- [ ] **Step 2: Tạo `src/ui/hooks/use-model-picker.ts`**:

```ts
// src/ui/hooks/use-model-picker.ts
import { useCallback, useState } from "react";
import type { ModelInfo } from "../models/registry.js";

export interface ModelPickerState {
  model: string;
  showModelPicker: boolean;
  modelPickerIndex: number;
  modelSearchQuery: string;
  disabledModels: Set<string>;
  disabledProviders: Set<string>;
  reasoningEffortByModel: Record<string, string>;
}

export interface ModelPickerActions {
  setModel: (model: string) => void;
  openModelPicker: () => void;
  closeModelPicker: () => void;
  setModelPickerIndex: (i: number) => void;
  setModelSearchQuery: (q: string) => void;
  toggleDisabledModel: (modelId: string) => void;
  toggleDisabledProvider: (provider: string) => void;
  setReasoningEffort: (modelId: string, effort: string) => void;
}

export function useModelPicker(initialModel: string): ModelPickerState & ModelPickerActions {
  const [model, setModel] = useState(initialModel);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [disabledModels, setDisabledModels] = useState<Set<string>>(new Set());
  const [disabledProviders, setDisabledProviders] = useState<Set<string>>(new Set());
  const [reasoningEffortByModel, setReasoningEffortByModel] = useState<Record<string, string>>({});

  const openModelPicker = useCallback(() => {
    setShowModelPicker(true);
    setModelPickerIndex(0);
    setModelSearchQuery("");
  }, []);

  const closeModelPicker = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  const toggleDisabledModel = useCallback((modelId: string) => {
    setDisabledModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, []);

  const toggleDisabledProvider = useCallback((provider: string) => {
    setDisabledProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }, []);

  const setReasoningEffort = useCallback((modelId: string, effort: string) => {
    setReasoningEffortByModel((prev) => ({ ...prev, [modelId]: effort }));
  }, []);

  return {
    model, setModel,
    showModelPicker, openModelPicker, closeModelPicker,
    modelPickerIndex, setModelPickerIndex,
    modelSearchQuery, setModelSearchQuery,
    disabledModels, toggleDisabledModel,
    disabledProviders, toggleDisabledProvider,
    reasoningEffortByModel, setReasoningEffort,
  };
}
```

- [ ] **Step 3: Trong `app.tsx`**, replace các state declarations tương ứng bằng hook call**:

```ts
// Thay thế:
const [model, setModel] = useState(startupConfig.model);
const [showModelPicker, setShowModelPicker] = useState(false);
// ... các state khác

// Bằng:
const modelPicker = useModelPicker(startupConfig.model);
const { model, setModel, showModelPicker, openModelPicker, closeModelPicker, ... } = modelPicker;
```

- [ ] **Step 4: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/hooks/use-model-picker.ts src/ui/app.tsx
git commit -m "refactor(ui): extract useModelPicker hook"
```

---

## Task 13: Extract `useMcpEditor` Hook

**Files:**
- Create: `src/ui/hooks/use-mcp-editor.ts`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/hooks/use-mcp-editor.ts`** — gom toàn bộ MCP modal/editor state và handlers (lines 1610-2018):

```ts
// src/ui/hooks/use-mcp-editor.ts
import { useCallback, useState } from "react";

export interface McpEditorState {
  showMcpModal: boolean;
  showMcpEditor: boolean;
  mcpServers: unknown[];
  mcpEditorDraft: unknown;
}

export function useMcpEditor() {
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [showMcpEditor, setShowMcpEditor] = useState(false);
  const [mcpServers, setMcpServers] = useState<unknown[]>([]);
  const [mcpEditorDraft, setMcpEditorDraft] = useState<unknown>(null);

  const openMcpModal = useCallback(async () => {
    // paste openMcpModal logic from app.tsx
  }, []);

  const openMcpEditor = useCallback((server?: unknown) => {
    // paste openMcpEditor logic
  }, []);

  const openCatalogMcp = useCallback((catalogEntry: unknown) => {
    // paste from app.tsx
  }, []);

  const editSavedMcp = useCallback((server: unknown) => {
    // paste from app.tsx
  }, []);

  const toggleSavedMcp = useCallback((serverId: string) => {
    // paste from app.tsx
  }, []);

  const deleteSavedMcp = useCallback((serverId: string) => {
    // paste from app.tsx
  }, []);

  const submitMcpEditor = useCallback(async () => {
    // paste from app.tsx
  }, []);

  return {
    showMcpModal, setShowMcpModal,
    showMcpEditor, setShowMcpEditor,
    mcpServers, setMcpServers,
    mcpEditorDraft, setMcpEditorDraft,
    openMcpModal, openMcpEditor, openCatalogMcp, editSavedMcp, toggleSavedMcp, deleteSavedMcp, submitMcpEditor,
  };
}
```

- [ ] **Step 2: Trong `app.tsx`**, replace các state và handlers bằng hook**:

```ts
const mcpEditor = useMcpEditor();
const { showMcpModal, openMcpModal, openMcpEditor, ... } = mcpEditor;
```

- [ ] **Step 3: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/hooks/use-mcp-editor.ts src/ui/app.tsx
git commit -m "refactor(ui): extract useMcpEditor hook"
```

---

## Task 14: Extract `useAgentEditor` Hook

**Files:**
- Create: `src/ui/hooks/use-agent-editor.ts`
- Modify: `src/ui/app.tsx`

- [ ] **Step 1: Tạo `src/ui/hooks/use-agent-editor.ts`** — gom state subagent/schedule modal (lines 1716-1788):

```ts
// src/ui/hooks/use-agent-editor.ts
import { useCallback, useState } from "react";

export function useAgentEditor() {
  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [showAgentsEditor, setShowAgentsEditor] = useState(false);
  const [subAgents, setSubAgents] = useState<unknown[]>([]);
  const [agentsEditorDraft, setAgentsEditorDraft] = useState<unknown>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [schedules, setSchedules] = useState<unknown[]>([]);

  const openAgentsModal = useCallback(async () => {
    // paste from app.tsx
  }, []);

  const openSubagentEditor = useCallback((agent?: unknown) => {
    // paste from app.tsx
  }, []);

  const openScheduleModal = useCallback(async () => {
    // paste from app.tsx
  }, []);

  const showScheduleDetails = useCallback((schedule: unknown) => {
    // paste from app.tsx
  }, []);

  const removeSchedule = useCallback(async (scheduleId: string) => {
    // paste from app.tsx
  }, []);

  return {
    showAgentsModal, setShowAgentsModal,
    showAgentsEditor, setShowAgentsEditor,
    subAgents, setSubAgents,
    agentsEditorDraft, setAgentsEditorDraft,
    showScheduleModal, setShowScheduleModal,
    schedules, setSchedules,
    openAgentsModal, openSubagentEditor, openScheduleModal, showScheduleDetails, removeSchedule,
  };
}
```

- [ ] **Step 2: Trong `app.tsx`**, replace với hook call**:

```ts
const agentEditor = useAgentEditor();
```

- [ ] **Step 3: Verify + Commit**

```powershell
bunx tsc --noEmit
git add src/ui/hooks/use-agent-editor.ts src/ui/app.tsx
git commit -m "refactor(ui): extract useAgentEditor hook"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Verify TypeScript**

```powershell
cd D:\Personal\Core\muonroi-cli && bunx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 2: Verify unit tests**

```powershell
bunx vitest run --reporter=verbose 2>&1 | tail -30
```

Expected: same pass/fail ratio as before refactor (không có test mới fail)

- [ ] **Step 3: Verify harness E2E (Windows)**

```powershell
bunx vitest -c vitest.harness.config.ts run tests/harness/
```

Expected: same results as before refactor

- [ ] **Step 4: Check line count của `app.tsx` còn lại**

```powershell
(Get-Content src/ui/app.tsx).Count
```

Expected: < 2000 dòng (sau khi tách xong tất cả components — App logic core vẫn còn các handler lớn như `handleKey`, `handleCommand`, `processMessage`)

- [ ] **Step 5: Update `REPO_DEEP_MAP.md`** — thêm các file mới vào map:

```markdown
| `src/ui/types.ts` | All UI interface/type definitions |
| `src/ui/constants.ts` | HERO_ROWS, SANDBOX_ROWS, WALLET_ROWS |
| `src/ui/utils/` | color, text, tools, modal, format utilities |
| `src/ui/components/` | Leaf components: hero-logo, session-header, prompt-box, message-view, diff-view, lsp-views, tool-result-views, media-views |
| `src/ui/modals/` | api-key, update, connect, model-picker, sandbox-picker, wallet-picker |
| `src/ui/hooks/` | use-model-picker, use-mcp-editor, use-agent-editor |
```

- [ ] **Step 6: Final commit**

```powershell
git add src/ REPO_DEEP_MAP.md 2>/dev/null
git commit -m "refactor(ui): final verification — app.tsx split complete"
```

---

## Phạm vi KHÔNG làm trong plan này

- **`handleKey`** (1780 dòng) — cần một PR riêng vì rủi ro cao; để lại trong `app.tsx`
- **`handleCommand`** (1000 dòng) — tương tự
- **`processMessage`** (354 dòng) — deeply coupled với App state; để lại

Các handler này có thể extract trong milestone tiếp theo sau khi phase này ổn định.

---

## Ước lượng kết quả

| Metric | Trước | Sau |
|--------|-------|-----|
| `app.tsx` lines | 9,368 | ~3,500–4,500 (còn handlers lớn) |
| Số file UI | 1 | ~25 |
| Max file size | 9,368 | ~800 |
| Circular deps | N/A | 0 (nếu theo thứ tự plan) |
