import type { AuthProvider } from "../config.js";

export type CompactEventType =
  | "user_msg"
  | "assistant_msg"
  | "tool_result"
  | "file_read"
  | "file_write_patch"
  | "command_run"
  | "error_observed"
  | "decision"
  | "plan_step";

export type CompactEvent = {
  index: number;
  at_iso: string;
  type: CompactEventType;
  turn_id?: string;
  provider?: AuthProvider;
  payload: Record<string, unknown>;
};

export type SummaryDecision = {
  at_iso?: string;
  decision: string;
  rationale: string;
  tradeoffs?: string;
};

export type SummaryArtifacts = {
  files_touched: string[];
  files_created: string[];
  commands_run: string[];
  errors_seen: string[];
  external_endpoints: string[];
};

export type SummaryState = {
  schema_version: 1;
  intent: string;
  constraints: string[];
  decisions: SummaryDecision[];
  progress: string[];
  open_questions: string[];
  next_steps: string[];
  artifacts: SummaryArtifacts;
  updated_at_iso: string;
};

export type CompactionPersistedState = {
  schema_version: 1;
  last_anchor_event_index: number;
  backfilled_from_rollout: boolean;
  summary_state: SummaryState;
  updated_at_iso: string;
};

export type CompactionSidecarPaths = {
  eventsJsonlPath: string;
  stateJsonPath: string;
  summaryMarkdownPath: string;
};

export const HIGH_WATERMARK_RATIO = 0.82;
export const TARGET_RATIO = 0.58;
export const MIN_RECENT_EVENTS = 12;
export const MIN_RECENT_USER_TURNS = 4;

export function createEmptySummaryState(nowIso?: string): SummaryState {
  const at = nowIso ?? new Date().toISOString();
  return {
    schema_version: 1,
    intent: "",
    constraints: [],
    decisions: [],
    progress: [],
    open_questions: [],
    next_steps: [],
    artifacts: {
      files_touched: [],
      files_created: [],
      commands_run: [],
      errors_seen: [],
      external_endpoints: [],
    },
    updated_at_iso: at,
  };
}

export function createDefaultCompactionPersistedState(nowIso?: string): CompactionPersistedState {
  const at = nowIso ?? new Date().toISOString();
  return {
    schema_version: 1,
    last_anchor_event_index: 0,
    backfilled_from_rollout: false,
    summary_state: createEmptySummaryState(at),
    updated_at_iso: at,
  };
}
