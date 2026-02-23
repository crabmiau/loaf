import { describe, expect, it } from "vitest";
import { StreamingChunkingPolicy } from "../streaming-chunking.js";

describe("StreamingChunkingPolicy", () => {
  it("drains one line in smooth mode", () => {
    const policy = new StreamingChunkingPolicy();
    const drainCount = policy.decide(
      {
        queuedLines: 1,
        oldestQueuedAgeMs: 10,
      },
      1_000,
    );
    expect(policy.modeKind()).toBe("smooth");
    expect(drainCount).toBe(1);
  });

  it("enters catch-up mode at depth threshold", () => {
    const policy = new StreamingChunkingPolicy();
    const drainCount = policy.decide(
      {
        queuedLines: 8,
        oldestQueuedAgeMs: 10,
      },
      1_000,
    );
    expect(policy.modeKind()).toBe("catchup");
    expect(drainCount).toBe(8);
  });

  it("enters catch-up mode at age threshold", () => {
    const policy = new StreamingChunkingPolicy();
    const drainCount = policy.decide(
      {
        queuedLines: 2,
        oldestQueuedAgeMs: 120,
      },
      1_000,
    );
    expect(policy.modeKind()).toBe("catchup");
    expect(drainCount).toBe(2);
  });

  it("does not drain in catch-up-only scope while smooth", () => {
    const policy = new StreamingChunkingPolicy();
    const drainCount = policy.decide(
      {
        queuedLines: 2,
        oldestQueuedAgeMs: 10,
      },
      1_000,
      "catchup_only",
    );
    expect(policy.modeKind()).toBe("smooth");
    expect(drainCount).toBe(0);
  });

  it("exits catch-up after hold below exit thresholds", () => {
    const policy = new StreamingChunkingPolicy();
    const t0 = 1_000;
    policy.decide(
      {
        queuedLines: 9,
        oldestQueuedAgeMs: 10,
      },
      t0,
    );
    expect(policy.modeKind()).toBe("catchup");

    policy.decide(
      {
        queuedLines: 2,
        oldestQueuedAgeMs: 40,
      },
      t0 + 200,
    );
    expect(policy.modeKind()).toBe("catchup");

    policy.decide(
      {
        queuedLines: 2,
        oldestQueuedAgeMs: 40,
      },
      t0 + 460,
    );
    expect(policy.modeKind()).toBe("smooth");
  });

  it("blocks quick catch-up re-entry unless backlog is severe", () => {
    const policy = new StreamingChunkingPolicy();
    const t0 = 1_000;
    policy.decide(
      {
        queuedLines: 9,
        oldestQueuedAgeMs: 10,
      },
      t0,
    );
    policy.decide(
      {
        queuedLines: 2,
        oldestQueuedAgeMs: 40,
      },
      t0 + 200,
    );
    policy.decide(
      {
        queuedLines: 2,
        oldestQueuedAgeMs: 40,
      },
      t0 + 460,
    );
    expect(policy.modeKind()).toBe("smooth");

    const blockedDrain = policy.decide(
      {
        queuedLines: 8,
        oldestQueuedAgeMs: 10,
      },
      t0 + 500,
      "catchup_only",
    );
    expect(policy.modeKind()).toBe("smooth");
    expect(blockedDrain).toBe(0);

    const severeDrain = policy.decide(
      {
        queuedLines: 64,
        oldestQueuedAgeMs: 10,
      },
      t0 + 520,
      "catchup_only",
    );
    expect(policy.modeKind()).toBe("catchup");
    expect(severeDrain).toBe(64);
  });
});
