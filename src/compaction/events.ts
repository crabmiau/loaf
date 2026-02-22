import type { ChatMessage } from "../chat-types.js";
import type { CompactEvent, CompactEventType, SummaryArtifacts } from "./types.js";

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>()]+/gi;
const MAX_EVENT_INLINE_CHARS = 1_200;

export function createCompactEvent(params: {
  index: number;
  type: CompactEventType;
  payload?: Record<string, unknown>;
  provider?: CompactEvent["provider"];
  turnId?: string;
  atIso?: string;
}): CompactEvent {
  return {
    index: Math.max(0, Math.floor(params.index)),
    at_iso: params.atIso ?? new Date().toISOString(),
    type: params.type,
    turn_id: params.turnId?.trim() || undefined,
    provider: params.provider,
    payload: params.payload ?? {},
  };
}

export function backfillEventsFromHistory(params: {
  history: ChatMessage[];
  startIndex?: number;
  provider?: CompactEvent["provider"];
}): CompactEvent[] {
  const start = Math.max(0, Math.floor(params.startIndex ?? 0));
  const nowIso = new Date().toISOString();
  const events: CompactEvent[] = [];
  let next = start;
  for (const message of params.history) {
    const text = message.text.trim();
    const imageCount = Array.isArray(message.images) ? message.images.length : 0;
    if (!text && imageCount === 0) {
      continue;
    }
    const type: CompactEventType = message.role === "assistant" ? "assistant_msg" : "user_msg";
    const payload: Record<string, unknown> = {
      text,
      image_count: imageCount,
    };
    events.push(
      createCompactEvent({
        index: next,
        type,
        payload,
        provider: params.provider,
        atIso: nowIso,
      }),
    );
    next += 1;
  }
  return events;
}

export function compactEventToChatMessage(event: CompactEvent): ChatMessage | null {
  if (event.type === "user_msg") {
    const text = readTrimmedString(event.payload.text);
    if (!text) {
      return null;
    }
    return {
      role: "user",
      text,
    };
  }

  if (event.type === "assistant_msg") {
    const text = readTrimmedString(event.payload.text);
    if (!text) {
      return null;
    }
    return {
      role: "assistant",
      text,
    };
  }

  const compact = renderOperationalEvent(event);
  if (!compact) {
    return null;
  }
  return {
    role: "assistant",
    text: compact,
  };
}

export function extractArtifactsFromEvents(events: CompactEvent[]): SummaryArtifacts {
  const artifacts: SummaryArtifacts = {
    files_touched: [],
    files_created: [],
    commands_run: [],
    errors_seen: [],
    external_endpoints: [],
  };

  for (const event of events) {
    const payload = event.payload ?? {};
    const allText = collectPayloadStrings(payload);
    addEndpoints(artifacts.external_endpoints, allText);

    if (event.type === "file_read") {
      const target = readTrimmedString(payload.path) || readTrimmedString(payload.file);
      appendUniqueInsensitive(artifacts.files_touched, target);
      continue;
    }

    if (event.type === "file_write_patch") {
      const target = readTrimmedString(payload.path) || readTrimmedString(payload.file);
      appendUniqueInsensitive(artifacts.files_touched, target);
      appendUniqueInsensitive(artifacts.files_created, readTrimmedString(payload.created_path));
      continue;
    }

    if (event.type === "command_run") {
      const rendered = renderCommandArtifact(payload);
      appendUniqueInsensitive(artifacts.commands_run, rendered);
      const bashCommand = readTrimmedString(payload.command);
      classifyBashFileOps(bashCommand, artifacts);
      continue;
    }

    if (event.type === "tool_result") {
      const toolName = readTrimmedString(payload.tool_name);
      const ok = payload.ok === true;
      if (!ok) {
        const error = readTrimmedString(payload.error) || `${toolName || "tool"} failed`;
        appendUniqueInsensitive(artifacts.errors_seen, error);
      }
      if (toolName === "bash") {
        classifyBashFileOps(readTrimmedString(payload.command), artifacts);
      }
      continue;
    }

    if (event.type === "error_observed") {
      const error = readTrimmedString(payload.message) || readTrimmedString(payload.error);
      appendUniqueInsensitive(artifacts.errors_seen, error);
    }
  }

  return artifacts;
}

function renderOperationalEvent(event: CompactEvent): string {
  if (event.type === "command_run") {
    const command = readTrimmedString(event.payload.command);
    const toolName = readTrimmedString(event.payload.tool_name);
    const label = toolName ? `tool ${toolName}` : "command";
    const body = command || clipInline(safeJson(event.payload), MAX_EVENT_INLINE_CHARS);
    return `[${label}] ${body}`.trim();
  }

  if (event.type === "tool_result") {
    const toolName = readTrimmedString(event.payload.tool_name) || "tool";
    const ok = event.payload.ok === true;
    const status = ok ? "ok" : "error";
    const detail =
      readTrimmedString(event.payload.output_preview) ||
      readTrimmedString(event.payload.error) ||
      clipInline(safeJson(event.payload), MAX_EVENT_INLINE_CHARS);
    return `[tool result:${status}] ${toolName} - ${detail}`.trim();
  }

  if (event.type === "error_observed") {
    const message = readTrimmedString(event.payload.message) || readTrimmedString(event.payload.error);
    return message ? `[error] ${message}` : "";
  }

  if (event.type === "decision") {
    const value = readTrimmedString(event.payload.decision);
    return value ? `[decision] ${value}` : "";
  }

  if (event.type === "plan_step") {
    const value = readTrimmedString(event.payload.step);
    return value ? `[plan step] ${value}` : "";
  }

  if (event.type === "file_read" || event.type === "file_write_patch") {
    const label = event.type === "file_read" ? "file read" : "file write";
    const target = readTrimmedString(event.payload.path) || readTrimmedString(event.payload.file);
    return target ? `[${label}] ${target}` : "";
  }

  return "";
}

function renderCommandArtifact(payload: Record<string, unknown>): string {
  const command = readTrimmedString(payload.command);
  const toolName = readTrimmedString(payload.tool_name);
  if (command) {
    return toolName ? `${toolName}: ${command}` : command;
  }
  if (toolName) {
    const input = isRecord(payload.input) ? safeJson(payload.input) : "";
    return input ? `${toolName} ${input}` : toolName;
  }
  return clipInline(safeJson(payload), 280);
}

function classifyBashFileOps(command: string, artifacts: SummaryArtifacts): void {
  const normalized = command.trim();
  if (!normalized) {
    return;
  }
  const readPatterns = [
    /\bcat\s+([^\s|;&]+)/i,
    /\btype\s+([^\s|;&]+)/i,
    /\brg\s+[^\n]*?\s+([^\s|;&]+)/i,
    /\bfindstr\s+[^\n]*?\s+([^\s|;&]+)/i,
  ];
  const writePatterns = [
    /\becho\s+.*?>+\s*([^\s|;&]+)/i,
    /\bcopy\s+[^\n]*?\s+([^\s|;&]+)/i,
    /\bmove\s+[^\n]*?\s+([^\s|;&]+)/i,
    /\bren(?:ame)?\s+([^\s|;&]+)/i,
    /\bdel(?:ete)?\s+([^\s|;&]+)/i,
  ];

  for (const pattern of readPatterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1]?.trim();
    appendUniqueInsensitive(artifacts.files_touched, candidate || "");
  }
  for (const pattern of writePatterns) {
    const match = normalized.match(pattern);
    const candidate = match?.[1]?.trim();
    appendUniqueInsensitive(artifacts.files_touched, candidate || "");
    if (/\becho\s+.*?>+/.test(normalized) || /\bcopy\b/i.test(normalized)) {
      appendUniqueInsensitive(artifacts.files_created, candidate || "");
    }
  }
}

function collectPayloadStrings(value: unknown): string[] {
  const results: string[] = [];
  walkStrings(value, results);
  return results;
}

function walkStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      output.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkStrings(item, output);
    }
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      walkStrings(entry, output);
    }
  }
}

function addEndpoints(target: string[], values: string[]): void {
  for (const value of values) {
    const matches = value.match(URL_PATTERN);
    if (!matches) {
      continue;
    }
    for (const url of matches) {
      appendUniqueInsensitive(target, url);
    }
  }
}

function appendUniqueInsensitive(target: string[], value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  const key = trimmed.toLowerCase();
  if (target.some((existing) => existing.toLowerCase() === key)) {
    return;
  }
  target.push(trimmed);
}

function clipInline(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
