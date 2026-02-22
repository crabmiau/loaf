import type { ChatMessage } from "../chat-types.js";
import type { CompactEvent, SummaryState } from "./types.js";

export type StructuredSummaryModelCall = (params: {
  systemInstruction: string;
  messages: ChatMessage[];
}) => Promise<string>;

export async function summarizeDeltaWithModel(params: {
  callModel: StructuredSummaryModelCall;
  oldSummaryState: SummaryState;
  deltaEvents: CompactEvent[];
  retryOnce?: boolean;
}): Promise<SummaryState> {
  const retry = params.retryOnce !== false;
  const primaryPrompt = buildSummarizerPrompt({
    oldSummaryState: params.oldSummaryState,
    deltaEvents: params.deltaEvents,
    jsonOnly: false,
  });
  const first = await params.callModel(primaryPrompt);
  const parsedFirst = parseSummaryStateFromText(first);
  if (parsedFirst) {
    return parsedFirst;
  }

  if (!retry) {
    throw new Error("summarizer response was not valid summary JSON");
  }

  const retryPrompt = buildSummarizerPrompt({
    oldSummaryState: params.oldSummaryState,
    deltaEvents: params.deltaEvents,
    jsonOnly: true,
  });
  const second = await params.callModel(retryPrompt);
  const parsedSecond = parseSummaryStateFromText(second);
  if (!parsedSecond) {
    throw new Error("summarizer response parsing failed after retry");
  }
  return parsedSecond;
}

export function buildSummarizerPrompt(params: {
  oldSummaryState: SummaryState;
  deltaEvents: CompactEvent[];
  jsonOnly: boolean;
}): { systemInstruction: string; messages: ChatMessage[] } {
  const schemaExample = {
    schema_version: 1,
    intent: "string",
    constraints: ["string"],
    decisions: [{ at_iso: "optional-iso", decision: "string", rationale: "string", tradeoffs: "optional-string" }],
    progress: ["string"],
    open_questions: ["string"],
    next_steps: ["string"],
    artifacts: {
      files_touched: ["string"],
      files_created: ["string"],
      commands_run: ["string"],
      errors_seen: ["string"],
      external_endpoints: ["string"],
    },
    updated_at_iso: "iso-string",
  };

  const systemLines = [
    "You are a context compaction summarizer.",
    "Return ONLY valid JSON matching the exact schema.",
    "Preserve task continuity, decisions, constraints, and artifact paths.",
    "Do not use markdown unless asked.",
  ];
  if (params.jsonOnly) {
    systemLines.push("CRITICAL: output must be raw JSON text, no code fences, no prose.");
  }

  const deltaRows = params.deltaEvents.map((event) => {
    const payload = compactJson(event.payload);
    return `- #${event.index} [${event.type}] ${payload}`;
  });
  const deltaText = deltaRows.length > 0 ? deltaRows.join("\n") : "- (empty delta)";

  const messages: ChatMessage[] = [
    {
      role: "user",
      text: [
        "Old SummaryState JSON:",
        compactJson(params.oldSummaryState),
        "",
        "Delta events to merge:",
        deltaText,
        "",
        "Output schema example (types only):",
        compactJson(schemaExample),
        "",
        "Instructions:",
        "- Keep schema keys and ordering stable.",
        "- Keep exact file paths and endpoint strings when present.",
        "- Prefer appending list items over replacing.",
        "- Keep concise items and avoid duplicates.",
        "- Output only the JSON object.",
      ].join("\n"),
    },
  ];

  return {
    systemInstruction: systemLines.join("\n"),
    messages,
  };
}

export function mergeSummaryStates(params: {
  previous: SummaryState;
  candidate: SummaryState;
  deltaArtifactAdditions?: SummaryState["artifacts"];
  nowIso?: string;
}): SummaryState {
  const previous = normalizeSummaryState(params.previous);
  const candidate = normalizeSummaryState(params.candidate);
  const deltaArtifacts = params.deltaArtifactAdditions
    ? normalizeArtifacts(params.deltaArtifactAdditions)
    : emptyArtifacts();
  const nowIso = params.nowIso ?? new Date().toISOString();

  return {
    schema_version: 1,
    intent: candidate.intent || previous.intent,
    constraints: appendDedup(previous.constraints, candidate.constraints),
    decisions: mergeDecisions(previous.decisions, candidate.decisions),
    progress: appendDedup(previous.progress, candidate.progress),
    open_questions: appendDedup(previous.open_questions, candidate.open_questions),
    next_steps: appendDedup(previous.next_steps, candidate.next_steps),
    artifacts: {
      files_touched: appendDedup(
        appendDedup(previous.artifacts.files_touched, candidate.artifacts.files_touched),
        deltaArtifacts.files_touched,
      ),
      files_created: appendDedup(
        appendDedup(previous.artifacts.files_created, candidate.artifacts.files_created),
        deltaArtifacts.files_created,
      ),
      commands_run: appendDedup(
        appendDedup(previous.artifacts.commands_run, candidate.artifacts.commands_run),
        deltaArtifacts.commands_run,
      ),
      errors_seen: appendDedup(
        appendDedup(previous.artifacts.errors_seen, candidate.artifacts.errors_seen),
        deltaArtifacts.errors_seen,
      ),
      external_endpoints: appendDedup(
        appendDedup(previous.artifacts.external_endpoints, candidate.artifacts.external_endpoints),
        deltaArtifacts.external_endpoints,
      ),
    },
    updated_at_iso: nowIso,
  };
}

export function parseSummaryStateFromText(text: string): SummaryState | null {
  const direct = tryParseJson(text);
  if (direct) {
    return normalizeSummaryState(direct);
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    const fenced = tryParseJson(fencedMatch[1]);
    if (fenced) {
      return normalizeSummaryState(fenced);
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const slice = text.slice(firstBrace, lastBrace + 1);
    const parsed = tryParseJson(slice);
    if (parsed) {
      return normalizeSummaryState(parsed);
    }
  }

  return null;
}

export function renderSummaryStateForPrompt(summaryState: SummaryState): string {
  const normalized = normalizeSummaryState(summaryState);
  const lines: string[] = ["[summary state]", `intent: ${normalized.intent || "(unspecified)"}`];
  if (normalized.constraints.length > 0) {
    lines.push("constraints:");
    for (const item of normalized.constraints.slice(-10)) {
      lines.push(`- ${item}`);
    }
  }
  if (normalized.decisions.length > 0) {
    lines.push("decisions:");
    for (const item of normalized.decisions.slice(-8)) {
      lines.push(`- ${item.decision} | rationale: ${item.rationale}`);
    }
  }
  if (normalized.progress.length > 0) {
    lines.push("progress:");
    for (const item of normalized.progress.slice(-12)) {
      lines.push(`- ${item}`);
    }
  }
  if (normalized.open_questions.length > 0) {
    lines.push("open questions:");
    for (const item of normalized.open_questions.slice(-8)) {
      lines.push(`- ${item}`);
    }
  }
  if (normalized.next_steps.length > 0) {
    lines.push("next steps:");
    for (const item of normalized.next_steps.slice(-8)) {
      lines.push(`- ${item}`);
    }
  }
  lines.push(
    `artifacts: touched=${normalized.artifacts.files_touched.length}, created=${normalized.artifacts.files_created.length}, commands=${normalized.artifacts.commands_run.length}, errors=${normalized.artifacts.errors_seen.length}, endpoints=${normalized.artifacts.external_endpoints.length}`,
  );
  lines.push(`updated_at: ${normalized.updated_at_iso}`);
  return lines.join("\n");
}

export function renderSummaryStateDebugMarkdown(summaryState: SummaryState): string {
  const normalized = normalizeSummaryState(summaryState);
  return [
    "# Compaction Summary State",
    "",
    "```json",
    JSON.stringify(normalized, null, 2),
    "```",
    "",
    "## Prompt View",
    "",
    "```text",
    renderSummaryStateForPrompt(normalized),
    "```",
  ].join("\n");
}

export function isSummaryEffectivelyEmpty(summaryState: SummaryState): boolean {
  const summary = normalizeSummaryState(summaryState);
  return (
    !summary.intent &&
    summary.constraints.length === 0 &&
    summary.decisions.length === 0 &&
    summary.progress.length === 0 &&
    summary.open_questions.length === 0 &&
    summary.next_steps.length === 0 &&
    summary.artifacts.files_touched.length === 0 &&
    summary.artifacts.files_created.length === 0 &&
    summary.artifacts.commands_run.length === 0 &&
    summary.artifacts.errors_seen.length === 0 &&
    summary.artifacts.external_endpoints.length === 0
  );
}

function normalizeSummaryState(value: unknown): SummaryState {
  const record = isRecord(value) ? value : {};
  const artifactsRecord = isRecord(record.artifacts) ? record.artifacts : {};
  const decisionsRaw = Array.isArray(record.decisions) ? record.decisions : [];
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
    intent: readTrimmedString(record.intent),
    constraints: normalizeStringList(record.constraints),
    decisions,
    progress: normalizeStringList(record.progress),
    open_questions: normalizeStringList(record.open_questions),
    next_steps: normalizeStringList(record.next_steps),
    artifacts: {
      files_touched: normalizeStringList(artifactsRecord.files_touched),
      files_created: normalizeStringList(artifactsRecord.files_created),
      commands_run: normalizeStringList(artifactsRecord.commands_run),
      errors_seen: normalizeStringList(artifactsRecord.errors_seen),
      external_endpoints: normalizeStringList(artifactsRecord.external_endpoints),
    },
    updated_at_iso: readIso(record.updated_at_iso) ?? new Date().toISOString(),
  };
}

function normalizeArtifacts(value: SummaryState["artifacts"]): SummaryState["artifacts"] {
  return {
    files_touched: normalizeStringList(value.files_touched),
    files_created: normalizeStringList(value.files_created),
    commands_run: normalizeStringList(value.commands_run),
    errors_seen: normalizeStringList(value.errors_seen),
    external_endpoints: normalizeStringList(value.external_endpoints),
  };
}

function emptyArtifacts(): SummaryState["artifacts"] {
  return {
    files_touched: [],
    files_created: [],
    commands_run: [],
    errors_seen: [],
    external_endpoints: [],
  };
}

function mergeDecisions(
  previous: SummaryState["decisions"],
  candidate: SummaryState["decisions"],
): SummaryState["decisions"] {
  const merged: SummaryState["decisions"] = [];
  const seen = new Set<string>();
  const push = (decision: SummaryState["decisions"][number]) => {
    const key = `${decision.decision.toLowerCase()}|${decision.rationale.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    merged.push(decision);
  };
  for (const item of previous) {
    push(item);
  }
  for (const item of candidate) {
    push(item);
  }
  return merged;
}

function appendDedup(existing: string[], incoming: string[]): string[] {
  const merged = [...existing];
  for (const item of incoming) {
    if (!item.trim()) {
      continue;
    }
    if (merged.some((current) => current.toLowerCase() === item.toLowerCase())) {
      continue;
    }
    merged.push(item);
  }
  return merged;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function tryParseJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    if (output.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      continue;
    }
    output.push(trimmed);
  }
  return output;
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
