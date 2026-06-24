import { Semantic } from "@muonroi/agent-harness-opentui";
import React from "react";
import { ProductStatusCard } from "../cards/product-status-card.js";
import { makePairKey } from "../components/bubble-layout.js";
import { CouncilInfoCardView } from "../components/council-info-card.js";
import { CouncilLeaderBubble } from "../components/council-leader-bubble.js";
import { CouncilMessageBubble } from "../components/council-message-bubble.js";
import { CouncilPhaseTimeline } from "../components/council-phase-timeline.js";
import { CouncilPlaceholderBubble } from "../components/council-placeholder-bubble.js";
import { CouncilQuestionCard } from "../components/council-question-card.js";
import { CouncilStatusList } from "../components/council-status-list.js";
import { CouncilSynthesisBanner } from "../components/council-synthesis-banner.js";
import { HaltRecoveryCard } from "../components/halt-recovery-card.js";
import { InitNewFormCard } from "../components/init-new-form-card.js";
import { computeMcpRunInfo, MessageView } from "../components/message-view.js";
import { PointToExistingFormCard } from "../components/point-to-existing-form-card.js";
import {
  DelegationTaskLine,
  InlineTool,
  ShimmerText,
  SubagentActivity,
  SubagentTaskLine,
} from "../components/tool-result-views.js";
import { Markdown } from "../markdown.js";
import { PaymentApprovalPanel } from "../modals/wallet-picker-modal.js";
import { PlanQuestionsPanel } from "../plan.js";
import { buildPreflightQuestion } from "../utils/format.js";
import { toolArgs, toolLabel, tryParseArg } from "../utils/tools.js";

export interface ChatFeedProps {
  getSide: any;
  getPartnerLast: any;
  resolveStyle: any;
  scrollRef: any;
  messages: any;
  expandedMessages: any;
  liveTurnSourceLabel: any;
  activeToolCalls: any;
  streamContent: any;
  isProcessing: any;
  activeSubagent: any;
  councilPhases: any;
  productStatus: any;
  councilStatuses: any;
  councilInfoCards: any;
  councilMessages: any;
  councilPlaceholders: any;
  reasoningActive: any;
  lastReasoningElapsedMs: any;
  streamReasoning: any;
  showPlanPanel: any;
  planQuestions: any;
  pqs: any;
  pendingPaymentApproval: any;
  activeHaltCard: any;
  haltSelectedIndex: any;
  initNewForm: any;
  pointToExistingForm: any;
  councilProgress: any;
  pendingCouncilQuestion: any;
  councilCardState: any;
  pendingCouncilPreflight: any;
  preflightCardState: any;
  t: any;
  width: any;
  modeInfo: any;
}

export function ChatFeed(props: ChatFeedProps) {
  const {
    modeInfo,
    getSide,
    getPartnerLast,
    resolveStyle,
    scrollRef,
    messages,
    expandedMessages,
    liveTurnSourceLabel,
    activeToolCalls,
    streamContent,
    isProcessing,
    activeSubagent,
    councilPhases,
    productStatus,
    councilStatuses,
    councilInfoCards,
    councilMessages,
    councilPlaceholders,
    reasoningActive,
    lastReasoningElapsedMs,
    streamReasoning,
    showPlanPanel,
    planQuestions,
    pqs,
    pendingPaymentApproval,
    activeHaltCard,
    haltSelectedIndex,
    initNewForm,
    pointToExistingForm,
    councilProgress,
    pendingCouncilQuestion,
    councilCardState,
    pendingCouncilPreflight,
    preflightCardState,
    t,
    width,
  } = props;

  return (
    <Semantic id="log" role="log" props={{ scrollTop: scrollRef.current?.scrollTop ?? 0 }}>
      {/* biome-ignore lint/suspicious/noExplicitAny: OpenTUI type mismatch for stickyStart */}
      <scrollbox ref={scrollRef} flexGrow={1} stickyScroll={true} stickyStart={"bottom" as any}>
        {(() => {
          const mcpRuns = computeMcpRunInfo(messages);
          // Phase 5 F7 — index of the last assistant message so
          // MessageView can skip auto-collapse on it (final answer
          // should always be fully visible, not hidden behind
          // "ctrl+e expand").
          let _lastAssistantIdx = -1;
          for (let _i = messages.length - 1; _i >= 0; _i--) {
            if (messages[_i]?.type === "assistant") {
              _lastAssistantIdx = _i;
              break;
            }
          }
          return messages.map((msg: any, i: any) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: append-only message log; index is part of the stable semantic id
            <Semantic
              key={`sem-${msg.timestamp?.getTime?.() ?? i}-${i}`}
              id={`msg-${i}`}
              role="listitem"
              name={`${msg.type ?? "msg"}:${String(msg.content ?? "").slice(0, 40)}`}
            >
              <MessageView
                key={`${msg.timestamp?.getTime?.() ?? i}-${msg.type}-${msg.remoteKey ?? ""}-${String(msg.content ?? "").slice(0, 24)}`}
                entry={msg}
                index={i}
                t={t}
                modeColor={modeInfo.color}
                expandedMessages={expandedMessages}
                mcpRun={mcpRuns[i]}
                isFinalAssistant={i === _lastAssistantIdx}
              />
            </Semantic>
          ));
        })()}
        {/* taskListSnapshot moved below scrollbox — renders as a
                          fixed-bottom panel so agent text can never push it up. */}
        {liveTurnSourceLabel && (activeToolCalls.length > 0 || streamContent || isProcessing) && (
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            <text fg={t.textMuted}>{liveTurnSourceLabel}</text>
          </box>
        )}
        {/* Active tool calls — pending inline */}
        {activeToolCalls.map((tc: any) =>
          tc.function.name === "task" ? (
            <SubagentTaskLine
              key={tc.id}
              t={t}
              agent={tryParseArg(tc, "agent") || "sub-agent"}
              label={toolArgs(tc) || "Working"}
              pending
            />
          ) : tc.function.name === "delegate" ? (
            <DelegationTaskLine
              key={tc.id}
              t={t}
              label={toolArgs(tc) || "Background research"}
              pending
              id={undefined}
            />
          ) : (
            <InlineTool key={tc.id} t={t} pending>
              {toolLabel(tc)}
            </InlineTool>
          ),
        )}
        {activeSubagent && <SubagentActivity t={t} status={activeSubagent} />}
        {councilPhases.length > 0 && (
          <Semantic id="council-phases" role="listbox" name="Council Phases">
            <CouncilPhaseTimeline phases={councilPhases} theme={t} />
          </Semantic>
        )}
        {productStatus && <ProductStatusCard data={productStatus} theme={t} />}
        {/* Halt/init-new/point-to-existing/council-progress cards moved
                          to render AFTER councilMessages below so the scrollbox's
                          sticky-bottom auto-scroll reveals them — when council
                          debate produces many tall bubbles they used to render
                          above the viewport. */}
        {councilStatuses.length > 0 && (
          <Semantic id="council-status" role="listbox" name="Council Status">
            <CouncilStatusList statuses={councilStatuses} theme={t} />
          </Semantic>
        )}
        {councilInfoCards.map((card: any, idx: any) => (
          <Semantic
            key={`sem-info-${idx}-${card.title}`}
            id={`council-card-${idx}`}
            role="listitem"
            name={card.title || `Council card ${idx}`}
          >
            <CouncilInfoCardView key={`info-card-${idx}-${card.title}`} card={card} terminalCols={width} theme={t} />
          </Semantic>
        ))}
        {councilMessages.map((cm: any, idx: any) => {
          const side: "left" | "right" =
            cm.kind === "debate" && cm.partner
              ? getSide(makePairKey(cm.speaker.role, cm.partner.role), cm.speaker.role)
              : "left";

          const semName = `${cm.kind}:${cm.speaker?.role ?? "?"}`;
          if (cm.kind === "leader") {
            return (
              <Semantic key={`sem-cm-${idx}`} id={`council-msg-${idx}`} role="listitem" name={semName} value={cm.text}>
                <CouncilLeaderBubble key={idx} msg={cm} terminalCols={width} />
              </Semantic>
            );
          }
          if (cm.kind === "synthesis") {
            return (
              <Semantic key={`sem-cm-${idx}`} id={`council-msg-${idx}`} role="listitem" name={semName} value={cm.text}>
                <CouncilSynthesisBanner key={idx} msg={cm} />
              </Semantic>
            );
          }
          const pairKey = cm.partner ? makePairKey(cm.speaker.role, cm.partner.role) : `solo::${cm.speaker.role}`;
          const partnerLastText = cm.partner ? getPartnerLast(pairKey, cm.partner.role) : undefined;
          return (
            <Semantic key={`sem-cm-${idx}`} id={`council-msg-${idx}`} role="listitem" name={semName} value={cm.text}>
              <CouncilMessageBubble
                key={idx}
                msg={cm}
                terminalCols={width}
                side={side}
                resolveStyle={resolveStyle}
                partnerLastText={partnerLastText}
                partnerRole={cm.partner?.role}
                theme={t}
              />
            </Semantic>
          );
        })}
        {Array.from(councilPlaceholders.entries()).map(([id, p]: any) => (
          <CouncilPlaceholderBubble
            key={id}
            role={p.role}
            side={p.side}
            terminalCols={width}
            color={p.color}
            theme={t}
            variant={p.variant}
          />
        ))}
        {/* Council question / preflight askcards render at the END of
                          the scrollbox (see below) so the bottom-sticky scroll
                          always anchors to the active question. Rendered here they
                          sat ABOVE trailing live content (streamContent,
                          councilProgress, reasoning pill), which owned the sticky
                          anchor during the council debate phase — leaving the card
                          scrolled above the fold so the user had to scroll UP to
                          find it. See fix/tui-askcard-anchor. */}
        {/* Reasoning pill — Claude-style "💭 Thinking…" while a
                          reasoning streak is active, then "💭 Thought for Ns"
                          once the model emits text or a tool call. CoT body is
                          discarded so we never re-render heavy markdown for it. */}
        {(reasoningActive || lastReasoningElapsedMs > 0) && (
          <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
            <text fg={t.textMuted}>
              {reasoningActive ? "💭 Thinking…" : `💭 Thought for ${(lastReasoningElapsedMs / 1000).toFixed(1)}s`}
            </text>
            {streamReasoning ? (
              <box border={["left"]} borderColor={t.textMuted} paddingLeft={2} marginTop={1} flexDirection="column">
                {reasoningActive ? (
                  // While actively streaming, render only the last 3
                  // non-empty lines as plain text to avoid Markdown
                  // re-parse overhead every 150ms.
                  <text fg={t.textMuted}>
                    {streamReasoning
                      .split("\n")
                      .filter((l: any) => l.trim().length > 0)
                      .slice(-3)
                      .join(" · ")}
                  </text>
                ) : (
                  <Markdown content={streamReasoning} t={t} />
                )}
              </box>
            ) : null}
          </box>
        )}
        {/* Streaming assistant content */}
        {streamContent && (
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            <Markdown content={streamContent} t={t} />
          </box>
        )}
        {/* Waiting indicator */}
        {isProcessing && !streamContent && activeToolCalls.length === 0 && (
          <ShimmerText t={t} text="Planning next moves" />
        )}
        {/* Plan questions panel — inline, OpenCode-style */}
        {showPlanPanel && <PlanQuestionsPanel t={t} questions={planQuestions} state={pqs} />}
        {pendingPaymentApproval && <PaymentApprovalPanel t={t} payment={pendingPaymentApproval} />}
        {/* Modals/wizards anchored to the bottom so sticky-bottom
                          auto-scroll keeps them in view even when councilMessages
                          fill the scrollbox. */}
        {activeHaltCard && (
          <HaltRecoveryCard halt={activeHaltCard} selectedIndex={haltSelectedIndex} terminalCols={width} theme={t} />
        )}
        {initNewForm && <InitNewFormCard state={initNewForm} terminalCols={width} theme={t} />}
        {pointToExistingForm && <PointToExistingFormCard state={pointToExistingForm} terminalCols={width} theme={t} />}
        {councilProgress && (
          <Semantic id="continue-as-council-progress" role="log" name="Council brainstorm">
            <box
              flexDirection="column"
              borderStyle="single"
              borderColor={councilProgress.status === "error" ? t.initFormError : t.text}
              padding={1}
              marginTop={1}
            >
              <text fg={t.text}>
                {councilProgress.status === "running" && "Council brainstorming — writing spec.md..."}
                {councilProgress.status === "done" &&
                  `Council brainstorm complete: ${councilProgress.specPath}${councilProgress.hasContent ? "" : " (no content — production council wiring deferred)"}`}
                {councilProgress.status === "error" && `Council brainstorm failed: ${councilProgress.error}`}
              </text>
            </box>
          </Semantic>
        )}
        {/* Active council askcards LAST so the bottom-sticky scroll
                          anchors to the pending question (moved here from above
                          streamContent/councilProgress — see fix/tui-askcard-anchor). */}
        {pendingCouncilQuestion && councilCardState && (
          <CouncilQuestionCard question={pendingCouncilQuestion} theme={t} state={councilCardState} />
        )}
        {pendingCouncilPreflight && preflightCardState && (
          <CouncilQuestionCard
            question={buildPreflightQuestion(pendingCouncilPreflight)}
            theme={t}
            state={preflightCardState}
          />
        )}
      </scrollbox>
    </Semantic>
  );
}
