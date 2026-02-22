import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompactEvent } from "./events.js";
import {
  appendCompactionEvents,
  deriveCompactionSidecarPaths,
  loadCompactionEvents,
  loadCompactionState,
  saveCompactionState,
  saveCompactionSummaryMirror,
} from "./storage.js";
import { createDefaultCompactionPersistedState } from "./types.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // noop
    }
  }
});

describe("compaction storage sidecars", () => {
  it("derives sidecar paths next to rollout and persists state/events", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loaf-compaction-"));
    cleanupDirs.push(root);

    const rolloutPath = path.join(root, "rollout-20260101-abc.jsonl");
    const paths = deriveCompactionSidecarPaths(rolloutPath);
    expect(paths.eventsJsonlPath.endsWith(".compact.events.jsonl")).toBe(true);
    expect(paths.stateJsonPath.endsWith(".compact.state.json")).toBe(true);
    expect(paths.summaryMarkdownPath.endsWith(".compact.summary.md")).toBe(true);

    const state = createDefaultCompactionPersistedState("2026-01-01T00:00:00.000Z");
    state.last_anchor_event_index = 12;
    state.summary_state.intent = "test anchored compaction";
    saveCompactionState(paths, state);

    appendCompactionEvents(paths, [
      createCompactEvent({
        index: 0,
        type: "user_msg",
        payload: { text: "hello" },
        atIso: "2026-01-01T00:00:01.000Z",
      }),
      createCompactEvent({
        index: 1,
        type: "assistant_msg",
        payload: { text: "world" },
        atIso: "2026-01-01T00:00:02.000Z",
      }),
    ]);

    saveCompactionSummaryMirror(paths, state.summary_state);

    const loadedState = loadCompactionState(paths);
    expect(loadedState.last_anchor_event_index).toBe(12);
    expect(loadedState.summary_state.intent).toBe("test anchored compaction");

    const loadedEvents = loadCompactionEvents(paths);
    expect(loadedEvents).toHaveLength(2);
    expect(loadedEvents[0]?.payload.text).toBe("hello");
    expect(loadedEvents[1]?.payload.text).toBe("world");

    const summaryMirror = fs.readFileSync(paths.summaryMarkdownPath, "utf8");
    expect(summaryMirror).toContain("# Compaction Summary State");
    expect(summaryMirror).toContain("test anchored compaction");
  });
});
