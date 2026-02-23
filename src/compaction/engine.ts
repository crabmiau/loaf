import type { ChatMessage } from "../chat-types.js";
import { compactEventToChatMessage, extractArtifactsFromEvents } from "./events.js";
import {
  HIGH_WATERMARK_RATIO,
  MIN_RECENT_EVENTS,
  MIN_RECENT_USER_TURNS,
  TARGET_RATIO,
  type CompactEvent,
  type SummaryState,
} from "./types.js";
import {
  isSummaryEffectivelyEmpty,
  mergeSummaryStates,
  renderSummaryStateForPrompt,
} from "./summarizer.js";

export type CompactionReason = "manual" | "auto" | "provider_switch";

export type AnchoredCompactionResult = {
  compressed: boolean;
  reason: CompactionReason;
  estimated_tokens_before: number;
  estimated_tokens_after: number;
  model_context_window: number;
  high_watermark_limit: number;
  target_limit: number;
  anchor_event_index_before: number;
  anchor_event_index_after: number;
  delta_event_count: number;
  summary_state: SummaryState;
};

export type AnchoredCompactionInput = {
  reason: CompactionReason;
  events: CompactEvent[];
  lastAnchorEventIndex: number;
  summaryState: SummaryState;
  modelContextWindowTokens: number;
  pinnedTokenEstimate: number;
  estimateHistoryTokens: (messages: ChatMessage[]) => number;
  summarizeDelta: (params: { oldSummaryState: SummaryState; deltaEvents: CompactEvent[] }) => Promise<SummaryState>;
  force?: boolean;
  highWatermarkRatio?: number;
  targetRatio?: number;
};

export function buildModelContextMessages(params: {
  summaryState: SummaryState;
  events: CompactEvent[];
  anchorEventIndex: number;
}): ChatMessage[] {
  const summaryMessage = buildSummaryMessage(params.summaryState);
  const eventMessages = toChatMessages(params.events.slice(Math.max(0, params.anchorEventIndex)));
  if (summaryMessage) {
    return [summaryMessage, ...eventMessages];
  }
  return eventMessages;
}

export function estimateCompactionContextTokens(params: {
  summaryState: SummaryState;
  events: CompactEvent[];
  anchorEventIndex: number;
  pinnedTokenEstimate: number;
  estimateHistoryTokens: (messages: ChatMessage[]) => number;
}): number {
  const messages = buildModelContextMessages({
    summaryState: params.summaryState,
    events: params.events,
    anchorEventIndex: params.anchorEventIndex,
  });
  return params.pinnedTokenEstimate + params.estimateHistoryTokens(messages);
}

export async function runAnchoredCompaction(input: AnchoredCompactionInput): Promise<AnchoredCompactionResult> {
  const events = input.events.slice().sort((left, right) => left.index - right.index);
  const highRatio = normalizeRatio(input.highWatermarkRatio, HIGH_WATERMARK_RATIO);
  const targetRatio = normalizeRatio(input.targetRatio, TARGET_RATIO);
  const highWatermarkLimit = Math.max(1, Math.floor(input.modelContextWindowTokens * highRatio));
  const targetLimit = Math.max(1, Math.floor(input.modelContextWindowTokens * targetRatio));
  const anchorBefore = Math.max(0, Math.floor(input.lastAnchorEventIndex));
  const startSummary = input.summaryState;

  const estimatedBefore = estimateCompactionContextTokens({
    summaryState: startSummary,
    events,
    anchorEventIndex: anchorBefore,
    pinnedTokenEstimate: input.pinnedTokenEstimate,
    estimateHistoryTokens: input.estimateHistoryTokens,
  });

  const overBudget = estimatedBefore > highWatermarkLimit;
  const mustRun = input.force === true || input.reason === "provider_switch";
  if (!overBudget && !mustRun) {
    return {
      compressed: false,
      reason: input.reason,
      estimated_tokens_before: estimatedBefore,
      estimated_tokens_after: estimatedBefore,
      model_context_window: input.modelContextWindowTokens,
      high_watermark_limit: highWatermarkLimit,
      target_limit: targetLimit,
      anchor_event_index_before: anchorBefore,
      anchor_event_index_after: anchorBefore,
      delta_event_count: 0,
      summary_state: startSummary,
    };
  }

  const newAnchor = mustRun
    ? selectForcedAnchorBoundary({
        events,
        anchorBefore,
      })
    : selectAnchorBoundary({
        events,
        anchorBefore,
        summaryState: startSummary,
        targetLimit,
        pinnedTokenEstimate: input.pinnedTokenEstimate,
        estimateHistoryTokens: input.estimateHistoryTokens,
      });

  if (newAnchor <= anchorBefore) {
    if (mustRun) {
      const deltaEvents: CompactEvent[] = [];
      const candidateSummary = await input.summarizeDelta({
        oldSummaryState: startSummary,
        deltaEvents,
      });
      const mergedSummary = mergeSummaryStates({
        previous: startSummary,
        candidate: candidateSummary,
        deltaArtifactAdditions: extractArtifactsFromEvents(deltaEvents),
      });
      const estimatedAfter = estimateCompactionContextTokens({
        summaryState: mergedSummary,
        events,
        anchorEventIndex: anchorBefore,
        pinnedTokenEstimate: input.pinnedTokenEstimate,
        estimateHistoryTokens: input.estimateHistoryTokens,
      });
      return {
        compressed: true,
        reason: input.reason,
        estimated_tokens_before: estimatedBefore,
        estimated_tokens_after: estimatedAfter,
        model_context_window: input.modelContextWindowTokens,
        high_watermark_limit: highWatermarkLimit,
        target_limit: targetLimit,
        anchor_event_index_before: anchorBefore,
        anchor_event_index_after: anchorBefore,
        delta_event_count: 0,
        summary_state: mergedSummary,
      };
    }
    return {
      compressed: false,
      reason: input.reason,
      estimated_tokens_before: estimatedBefore,
      estimated_tokens_after: estimatedBefore,
      model_context_window: input.modelContextWindowTokens,
      high_watermark_limit: highWatermarkLimit,
      target_limit: targetLimit,
      anchor_event_index_before: anchorBefore,
      anchor_event_index_after: anchorBefore,
      delta_event_count: 0,
      summary_state: startSummary,
    };
  }

  const deltaEvents = events.filter((event) => event.index >= anchorBefore && event.index < newAnchor);
  const candidateSummary = await input.summarizeDelta({
    oldSummaryState: startSummary,
    deltaEvents,
  });
  const mergedSummary = mergeSummaryStates({
    previous: startSummary,
    candidate: candidateSummary,
    deltaArtifactAdditions: extractArtifactsFromEvents(deltaEvents),
  });

  const estimatedAfter = estimateCompactionContextTokens({
    summaryState: mergedSummary,
    events,
    anchorEventIndex: newAnchor,
    pinnedTokenEstimate: input.pinnedTokenEstimate,
    estimateHistoryTokens: input.estimateHistoryTokens,
  });

  return {
    compressed: true,
    reason: input.reason,
    estimated_tokens_before: estimatedBefore,
    estimated_tokens_after: estimatedAfter,
    model_context_window: input.modelContextWindowTokens,
    high_watermark_limit: highWatermarkLimit,
    target_limit: targetLimit,
    anchor_event_index_before: anchorBefore,
    anchor_event_index_after: newAnchor,
    delta_event_count: deltaEvents.length,
    summary_state: mergedSummary,
  };
}

function selectAnchorBoundary(params: {
  events: CompactEvent[];
  anchorBefore: number;
  summaryState: SummaryState;
  targetLimit: number;
  pinnedTokenEstimate: number;
  estimateHistoryTokens: (messages: ChatMessage[]) => number;
}): number {
  const events = params.events;
  if (events.length === 0) {
    return params.anchorBefore;
  }

  let candidate = Math.max(params.anchorBefore, 0);
  const maxCandidate = maxAnchorCandidate(events, candidate);
  for (; candidate <= maxCandidate; candidate += 1) {
    const estimate = estimateCompactionContextTokens({
      summaryState: params.summaryState,
      events,
      anchorEventIndex: candidate,
      pinnedTokenEstimate: params.pinnedTokenEstimate,
      estimateHistoryTokens: params.estimateHistoryTokens,
    });
    if (estimate <= params.targetLimit) {
      return candidate;
    }
  }
  return maxCandidate;
}

function selectForcedAnchorBoundary(params: { events: CompactEvent[]; anchorBefore: number }): number {
  const candidate = Math.max(params.anchorBefore, 0);
  return maxAnchorCandidate(params.events, candidate);
}

function maxAnchorCandidate(events: CompactEvent[], anchorBefore: number): number {
  if (events.length === 0) {
    return anchorBefore;
  }
  const minimumRecentStart = findMinimumRecentStart(events);
  return Math.max(anchorBefore, minimumRecentStart);
}

function findMinimumRecentStart(events: CompactEvent[]): number {
  if (events.length === 0) {
    return 0;
  }
  const firstIndex = events[0]!.index;
  const keepByCount = events[Math.max(0, events.length - MIN_RECENT_EVENTS)]?.index ?? firstIndex;
  const keepByUserTurns = findRecentUserTurnBoundary(events, MIN_RECENT_USER_TURNS);
  return Math.max(firstIndex, Math.min(keepByCount, keepByUserTurns));
}

function findRecentUserTurnBoundary(events: CompactEvent[], minUserTurns: number): number {
  if (minUserTurns <= 0) {
    return events[0]?.index ?? 0;
  }
  let seenUsers = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event) {
      continue;
    }
    if (event.type !== "user_msg") {
      continue;
    }
    seenUsers += 1;
    if (seenUsers >= minUserTurns) {
      return event.index;
    }
  }
  return events[0]?.index ?? 0;
}

function buildSummaryMessage(summaryState: SummaryState): ChatMessage | null {
  if (isSummaryEffectivelyEmpty(summaryState)) {
    return null;
  }
  return {
    role: "assistant",
    text: renderSummaryStateForPrompt(summaryState),
  };
}

function toChatMessages(events: CompactEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    const message = compactEventToChatMessage(event);
    if (!message) {
      continue;
    }
    messages.push(message);
  }
  return messages;
}

function normalizeRatio(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(0.99, Math.max(0.1, value));
}
