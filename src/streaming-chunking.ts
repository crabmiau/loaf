export type StreamingCommitScope = "any" | "catchup_only";
export type StreamingChunkingMode = "smooth" | "catchup";

export type StreamingQueueSnapshot = {
  queuedLines: number;
  oldestQueuedAgeMs: number | null;
};

const ENTER_QUEUE_DEPTH_LINES = 8;
const ENTER_OLDEST_AGE_MS = 120;
const EXIT_QUEUE_DEPTH_LINES = 2;
const EXIT_OLDEST_AGE_MS = 40;
const EXIT_HOLD_MS = 250;
const REENTER_CATCH_UP_HOLD_MS = 250;
const SEVERE_QUEUE_DEPTH_LINES = 64;
const SEVERE_OLDEST_AGE_MS = 300;

export class StreamingChunkingPolicy {
  private mode: StreamingChunkingMode = "smooth";
  private belowExitThresholdSinceMs: number | null = null;
  private lastCatchUpExitAtMs: number | null = null;

  modeKind(): StreamingChunkingMode {
    return this.mode;
  }

  reset(): void {
    this.mode = "smooth";
    this.belowExitThresholdSinceMs = null;
    this.lastCatchUpExitAtMs = null;
  }

  decide(
    snapshot: StreamingQueueSnapshot,
    nowMs: number,
    scope: StreamingCommitScope = "any",
  ): number {
    if (snapshot.queuedLines === 0) {
      if (this.mode === "catchup") {
        this.lastCatchUpExitAtMs = nowMs;
      }
      this.mode = "smooth";
      this.belowExitThresholdSinceMs = null;
      return 0;
    }

    if (this.mode === "smooth") {
      this.maybeEnterCatchUp(snapshot, nowMs);
    } else {
      this.maybeExitCatchUp(snapshot, nowMs);
    }

    if (scope === "catchup_only" && this.mode !== "catchup") {
      return 0;
    }

    return this.mode === "catchup" ? Math.max(1, snapshot.queuedLines) : 1;
  }

  private maybeEnterCatchUp(snapshot: StreamingQueueSnapshot, nowMs: number): void {
    if (!shouldEnterCatchUp(snapshot)) {
      return;
    }
    const holdActive =
      this.lastCatchUpExitAtMs !== null && nowMs - this.lastCatchUpExitAtMs < REENTER_CATCH_UP_HOLD_MS;
    if (holdActive && !isSevereBacklog(snapshot)) {
      return;
    }
    this.mode = "catchup";
    this.belowExitThresholdSinceMs = null;
    this.lastCatchUpExitAtMs = null;
  }

  private maybeExitCatchUp(snapshot: StreamingQueueSnapshot, nowMs: number): void {
    if (!shouldExitCatchUp(snapshot)) {
      this.belowExitThresholdSinceMs = null;
      return;
    }
    if (this.belowExitThresholdSinceMs === null) {
      this.belowExitThresholdSinceMs = nowMs;
      return;
    }
    if (nowMs - this.belowExitThresholdSinceMs >= EXIT_HOLD_MS) {
      this.mode = "smooth";
      this.belowExitThresholdSinceMs = null;
      this.lastCatchUpExitAtMs = nowMs;
    }
  }
}

function shouldEnterCatchUp(snapshot: StreamingQueueSnapshot): boolean {
  return (
    snapshot.queuedLines >= ENTER_QUEUE_DEPTH_LINES ||
    (snapshot.oldestQueuedAgeMs !== null && snapshot.oldestQueuedAgeMs >= ENTER_OLDEST_AGE_MS)
  );
}

function shouldExitCatchUp(snapshot: StreamingQueueSnapshot): boolean {
  return (
    snapshot.queuedLines <= EXIT_QUEUE_DEPTH_LINES &&
    snapshot.oldestQueuedAgeMs !== null &&
    snapshot.oldestQueuedAgeMs <= EXIT_OLDEST_AGE_MS
  );
}

function isSevereBacklog(snapshot: StreamingQueueSnapshot): boolean {
  return (
    snapshot.queuedLines >= SEVERE_QUEUE_DEPTH_LINES ||
    (snapshot.oldestQueuedAgeMs !== null && snapshot.oldestQueuedAgeMs >= SEVERE_OLDEST_AGE_MS)
  );
}
