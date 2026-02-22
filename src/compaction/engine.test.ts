import { describe, expect, it } from "vitest";
import {
  buildModelContextMessages,
  runAnchoredCompaction,
  type CompactionReason,
} from "./engine.js";
import type { CompactEvent, SummaryState } from "./types.js";
import { createEmptySummaryState } from "./types.js";

function estimateMessages(messages: Array<{ text: string }>): number {
  let total = 0;
  for (const message of messages) {
    total += Math.ceil(message.text.length / 4) + 18;
  }
  return total;
}

function makeEvents(count: number): CompactEvent[] {
  const events: CompactEvent[] = [];
  for (let i = 0; i < count; i += 1) {
    const user = i % 2 === 0;
    events.push({
      index: i,
      at_iso: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
      type: user ? "user_msg" : "assistant_msg",
      payload: {
        text: `${user ? "user" : "assistant"} message ${i} `.repeat(8),
      },
    });
  }
  return events;
}

function summarizerFor(reason: CompactionReason) {
  return async (params: { oldSummaryState: SummaryState; deltaEvents: CompactEvent[] }): Promise<SummaryState> => ({
    ...params.oldSummaryState,
    schema_version: 1,
    progress: [
      ...params.oldSummaryState.progress,
      `${reason}: delta ${params.deltaEvents[0]?.index ?? -1}-${params.deltaEvents.at(-1)?.index ?? -1}`,
    ],
    updated_at_iso: new Date().toISOString(),
  });
}

describe("runAnchoredCompaction", () => {
  it("compacts in delta-only passes and preserves previous summary content", async () => {
    const events = makeEvents(28);
    const first = await runAnchoredCompaction({
      reason: "auto",
      events,
      lastAnchorEventIndex: 0,
      summaryState: createEmptySummaryState("2025-01-01T00:00:00.000Z"),
      modelContextWindowTokens: 700,
      pinnedTokenEstimate: 40,
      estimateHistoryTokens: estimateMessages,
      summarizeDelta: summarizerFor("auto"),
      force: true,
    });

    expect(first.compressed).toBe(true);
    expect(first.anchor_event_index_after).toBeGreaterThan(first.anchor_event_index_before);
    expect(first.delta_event_count).toBeGreaterThan(0);
    expect(first.summary_state.progress.length).toBe(1);

    const withNewEvents = [...events, ...makeEvents(10).map((event) => ({ ...event, index: event.index + 28 }))];
    const second = await runAnchoredCompaction({
      reason: "auto",
      events: withNewEvents,
      lastAnchorEventIndex: first.anchor_event_index_after,
      summaryState: first.summary_state,
      modelContextWindowTokens: 700,
      pinnedTokenEstimate: 40,
      estimateHistoryTokens: estimateMessages,
      summarizeDelta: summarizerFor("auto"),
      force: true,
    });

    expect(second.compressed).toBe(true);
    expect(second.anchor_event_index_before).toBe(first.anchor_event_index_after);
    expect(second.anchor_event_index_after).toBeGreaterThan(second.anchor_event_index_before);
    expect(second.summary_state.progress.length).toBeGreaterThanOrEqual(2);
    expect(second.summary_state.progress[0]).toContain("delta");
  });

  it("keeps minimum recent events and user turns after compaction", async () => {
    const events = makeEvents(50);
    const result = await runAnchoredCompaction({
      reason: "manual",
      events,
      lastAnchorEventIndex: 0,
      summaryState: createEmptySummaryState("2025-01-01T00:00:00.000Z"),
      modelContextWindowTokens: 560,
      pinnedTokenEstimate: 36,
      estimateHistoryTokens: estimateMessages,
      summarizeDelta: async ({ oldSummaryState }) => oldSummaryState,
      force: true,
    });

    expect(result.compressed).toBe(true);
    const kept = events.filter((event) => event.index >= result.anchor_event_index_after);
    const keptUsers = kept.filter((event) => event.type === "user_msg");
    expect(kept.length).toBeGreaterThanOrEqual(12);
    expect(keptUsers.length).toBeGreaterThanOrEqual(4);

    const contextMessages = buildModelContextMessages({
      summaryState: result.summary_state,
      events,
      anchorEventIndex: result.anchor_event_index_after,
    });
    expect(contextMessages.length).toBeGreaterThan(0);
  });
});
