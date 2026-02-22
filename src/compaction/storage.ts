import fs from "node:fs";
import path from "node:path";
import type {
  CompactEvent,
  CompactionPersistedState,
  CompactionSidecarPaths,
  SummaryState,
} from "./types.js";
import {
  createDefaultCompactionPersistedState,
  createEmptySummaryState,
} from "./types.js";
import { renderSummaryStateDebugMarkdown } from "./summarizer.js";

const EVENTS_SUFFIX = ".compact.events.jsonl";
const STATE_SUFFIX = ".compact.state.json";
const SUMMARY_SUFFIX = ".compact.summary.md";

export function deriveCompactionSidecarPaths(rolloutPath: string): CompactionSidecarPaths {
  const parsed = path.parse(rolloutPath);
  const baseName = parsed.ext.toLowerCase() === ".jsonl" ? parsed.name : parsed.base;
  const prefix = path.join(parsed.dir, baseName);
  return {
    eventsJsonlPath: `${prefix}${EVENTS_SUFFIX}`,
    stateJsonPath: `${prefix}${STATE_SUFFIX}`,
    summaryMarkdownPath: `${prefix}${SUMMARY_SUFFIX}`,
  };
}

export function loadCompactionState(paths: CompactionSidecarPaths): CompactionPersistedState {
  if (!fs.existsSync(paths.stateJsonPath)) {
    return createDefaultCompactionPersistedState();
  }
  try {
    const raw = fs.readFileSync(paths.stateJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return createDefaultCompactionPersistedState();
    }

    const lastAnchorRaw = parsed.last_anchor_event_index;
    const lastAnchor =
      typeof lastAnchorRaw === "number" && Number.isFinite(lastAnchorRaw) && lastAnchorRaw >= 0
        ? Math.floor(lastAnchorRaw)
        : 0;

    const backfilled = parsed.backfilled_from_rollout === true;
    const summary = normalizeSummaryState(parsed.summary_state);
    const updatedAt = readIso(parsed.updated_at_iso) ?? new Date().toISOString();

    return {
      schema_version: 1,
      last_anchor_event_index: lastAnchor,
      backfilled_from_rollout: backfilled,
      summary_state: summary,
      updated_at_iso: updatedAt,
    };
  } catch {
    return createDefaultCompactionPersistedState();
  }
}

export function saveCompactionState(paths: CompactionSidecarPaths, state: CompactionPersistedState): void {
  const normalized: CompactionPersistedState = {
    schema_version: 1,
    last_anchor_event_index: Math.max(0, Math.floor(state.last_anchor_event_index)),
    backfilled_from_rollout: state.backfilled_from_rollout === true,
    summary_state: normalizeSummaryState(state.summary_state),
    updated_at_iso: readIso(state.updated_at_iso) ?? new Date().toISOString(),
  };

  writeAtomicJson(paths.stateJsonPath, normalized);
}

export function loadCompactionEvents(paths: CompactionSidecarPaths): CompactEvent[] {
  if (!fs.existsSync(paths.eventsJsonlPath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(paths.eventsJsonlPath, "utf8");
    const lines = raw
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const events: CompactEvent[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const normalized = normalizeCompactEvent(parsed);
      if (!normalized) {
        continue;
      }
      events.push(normalized);
    }
    events.sort((left, right) => left.index - right.index);
    return events;
  } catch {
    return [];
  }
}

export function appendCompactionEvents(paths: CompactionSidecarPaths, events: CompactEvent[]): void {
  if (events.length === 0) {
    return;
  }
  ensureParentDir(paths.eventsJsonlPath);
  const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");
  fs.appendFileSync(paths.eventsJsonlPath, payload, "utf8");
}

export function overwriteCompactionEvents(paths: CompactionSidecarPaths, events: CompactEvent[]): void {
  ensureParentDir(paths.eventsJsonlPath);
  const payload = events.map((event) => JSON.stringify(event)).join("\n");
  writeAtomicText(paths.eventsJsonlPath, payload ? `${payload}\n` : "");
}

export function saveCompactionSummaryMirror(paths: CompactionSidecarPaths, summaryState: SummaryState): void {
  const markdown = renderSummaryStateDebugMarkdown(summaryState);
  ensureParentDir(paths.summaryMarkdownPath);
  writeAtomicText(paths.summaryMarkdownPath, `${markdown}\n`);
}

function normalizeCompactEvent(value: unknown): CompactEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const indexRaw = value.index;
  if (typeof indexRaw !== "number" || !Number.isFinite(indexRaw) || indexRaw < 0) {
    return null;
  }
  const index = Math.floor(indexRaw);
  const atIso = readIso(value.at_iso);
  const type = readTrimmedString(value.type);
  if (!atIso || !type) {
    return null;
  }

  const allowedTypes = new Set([
    "user_msg",
    "assistant_msg",
    "tool_result",
    "file_read",
    "file_write_patch",
    "command_run",
    "error_observed",
    "decision",
    "plan_step",
  ]);
  if (!allowedTypes.has(type)) {
    return null;
  }

  const turnId = readTrimmedString(value.turn_id) || undefined;
  const providerRaw = readTrimmedString(value.provider);
  const provider =
    providerRaw === "openai" || providerRaw === "openrouter" || providerRaw === "antigravity"
      ? providerRaw
      : undefined;
  const payload = isRecord(value.payload) ? value.payload : {};

  return {
    index,
    at_iso: atIso,
    type: type as CompactEvent["type"],
    turn_id: turnId,
    provider,
    payload,
  };
}

function normalizeSummaryState(value: unknown): SummaryState {
  if (!isRecord(value)) {
    return createEmptySummaryState();
  }
  const nowIso = new Date().toISOString();
  const artifactsRecord = isRecord(value.artifacts) ? value.artifacts : {};
  const decisionsRaw = Array.isArray(value.decisions) ? value.decisions : [];
  const decisions = decisionsRaw
    .map((item) => (isRecord(item) ? item : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      at_iso: readIso(item.at_iso) ?? undefined,
      decision: readTrimmedString(item.decision),
      rationale: readTrimmedString(item.rationale),
      tradeoffs: readTrimmedString(item.tradeoffs) || undefined,
    }))
    .filter((item) => item.decision && item.rationale);

  return {
    schema_version: 1,
    intent: readTrimmedString(value.intent),
    constraints: normalizeStringList(value.constraints),
    decisions,
    progress: normalizeStringList(value.progress),
    open_questions: normalizeStringList(value.open_questions),
    next_steps: normalizeStringList(value.next_steps),
    artifacts: {
      files_touched: normalizeStringList(artifactsRecord.files_touched),
      files_created: normalizeStringList(artifactsRecord.files_created),
      commands_run: normalizeStringList(artifactsRecord.commands_run),
      errors_seen: normalizeStringList(artifactsRecord.errors_seen),
      external_endpoints: normalizeStringList(artifactsRecord.external_endpoints),
    },
    updated_at_iso: readIso(value.updated_at_iso) ?? nowIso,
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    list.push(trimmed);
  }
  return list;
}

function writeAtomicJson(filePath: string, payload: unknown): void {
  writeAtomicText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeAtomicText(filePath: string, payload: string): void {
  ensureParentDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, payload, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function readIso(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
