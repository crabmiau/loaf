import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { JsonValue, ToolDefinition, ToolInput, ToolResult } from "../types.js";

type ReadFileInput = ToolInput & {
  file_path?: JsonValue;
  offset?: JsonValue;
  limit?: JsonValue;
  mode?: JsonValue;
  indentation?: JsonValue;
};

type ListDirInput = ToolInput & {
  dir_path?: JsonValue;
  offset?: JsonValue;
  limit?: JsonValue;
  depth?: JsonValue;
};

type GrepFilesInput = ToolInput & {
  pattern?: JsonValue;
  include?: JsonValue;
  path?: JsonValue;
  limit?: JsonValue;
};

type ApplyPatchInput = ToolInput & {
  input?: JsonValue;
};

type ReadMode = "slice" | "indentation";

type IndentationOptions = {
  anchorLine: number | null;
  maxLevels: number;
  includeSiblings: boolean;
  includeHeader: boolean;
  maxLines: number | null;
};

type LineRecord = {
  number: number;
  raw: string;
  display: string;
  indent: number;
};

type DirEntryKind = "directory" | "file" | "symlink" | "other";

type DirEntryRecord = {
  name: string;
  displayName: string;
  depth: number;
  kind: DirEntryKind;
};

type PatchHunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

type AddFileHunk = {
  type: "add_file";
  filePath: string;
  contents: string;
};

type DeleteFileHunk = {
  type: "delete_file";
  filePath: string;
};

type UpdateFileChunk = {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
};

type UpdateFileHunk = {
  type: "update_file";
  filePath: string;
  movePath: string | null;
  chunks: UpdateFileChunk[];
};

type ReplacementRecord = {
  startIndex: number;
  oldLength: number;
  newLines: string[];
};

const MAX_LINE_LENGTH = 500;
const TAB_WIDTH = 4;
const READ_FILE_COMMENT_PREFIXES = ["#", "//", "--"];

const MAX_ENTRY_LENGTH = 500;
const LIST_DIR_INDENTATION_SPACES = 2;

const GREP_DEFAULT_LIMIT = 100;
const GREP_MAX_LIMIT = 2_000;
const GREP_COMMAND_TIMEOUT_MS = 30_000;

const PATCH_BEGIN_MARKER = "*** Begin Patch";
const PATCH_END_MARKER = "*** End Patch";
const PATCH_ADD_FILE_MARKER = "*** Add File: ";
const PATCH_DELETE_FILE_MARKER = "*** Delete File: ";
const PATCH_UPDATE_FILE_MARKER = "*** Update File: ";
const PATCH_MOVE_TO_MARKER = "*** Move to: ";
const PATCH_EOF_MARKER = "*** End of File";
const PATCH_CHANGE_CONTEXT_MARKER = "@@ ";
const PATCH_EMPTY_CHANGE_CONTEXT_MARKER = "@@";

const readFileTool: ToolDefinition<ReadFileInput> = {
  name: "read_file",
  description:
    "Reads a local file with 1-indexed line numbers, supporting slice and indentation-aware block modes.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Absolute path to the file",
      },
      offset: {
        type: "number",
        description: "The line number to start reading from. Must be 1 or greater.",
      },
      limit: {
        type: "number",
        description: "The maximum number of lines to return.",
      },
      mode: {
        type: "string",
        description:
          'Optional mode selector: "slice" for simple ranges (default) or "indentation" to expand around an anchor line.',
      },
      indentation: {
        type: "object",
        properties: {
          anchor_line: {
            type: "number",
            description: "Anchor line to center the indentation lookup on (defaults to offset).",
          },
          max_levels: {
            type: "number",
            description: "How many parent indentation levels (smaller indents) to include.",
          },
          include_siblings: {
            type: "boolean",
            description: "When true, include additional blocks that share the anchor indentation.",
          },
          include_header: {
            type: "boolean",
            description: "Include doc comments or attributes directly above the selected block.",
          },
          max_lines: {
            type: "number",
            description: "Hard cap on the number of lines returned when using indentation mode.",
          },
        },
        additionalProperties: false,
      },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  run: async (input) => {
    const filePath = asNonEmptyString(input.file_path);
    if (!filePath) {
      return invalidInput("read_file requires a non-empty `file_path`.");
    }
    if (!path.isAbsolute(filePath)) {
      return errorMessage("file_path must be an absolute path");
    }

    const offset = parsePositiveIntegerOrDefault(input.offset, 1);
    if (offset <= 0) {
      return errorMessage("offset must be a 1-indexed line number");
    }
    const limit = parsePositiveIntegerOrDefault(input.limit, 2_000);
    if (limit <= 0) {
      return errorMessage("limit must be greater than zero");
    }

    const mode = normalizeReadMode(input.mode);
    const lines = await readUtf8Lines(filePath);
    if (!lines.ok) {
      return errorMessage(`failed to read file: ${lines.error}`);
    }

    const records = buildLineRecords(lines.lines);
    if (mode === "indentation") {
      return runIndentationRead(records, {
        offset,
        limit,
        indentation: parseIndentationOptions(input.indentation),
      });
    }
    return runSliceRead(records, offset, limit);
  },
};

const listDirTool: ToolDefinition<ListDirInput> = {
  name: "list_dir",
  description:
    "Lists entries in a local directory with 1-indexed entry numbers and simple type labels.",
  inputSchema: {
    type: "object",
    properties: {
      dir_path: {
        type: "string",
        description: "Absolute path to the directory to list.",
      },
      offset: {
        type: "number",
        description: "The entry number to start listing from. Must be 1 or greater.",
      },
      limit: {
        type: "number",
        description: "The maximum number of entries to return.",
      },
      depth: {
        type: "number",
        description: "The maximum directory depth to traverse. Must be 1 or greater.",
      },
    },
    required: ["dir_path"],
    additionalProperties: false,
  },
  run: async (input) => {
    const dirPath = asNonEmptyString(input.dir_path);
    if (!dirPath) {
      return invalidInput("list_dir requires a non-empty `dir_path`.");
    }
    if (!path.isAbsolute(dirPath)) {
      return errorMessage("dir_path must be an absolute path");
    }

    const offset = parsePositiveIntegerOrDefault(input.offset, 1);
    if (offset <= 0) {
      return errorMessage("offset must be a 1-indexed entry number");
    }
    const limit = parsePositiveIntegerOrDefault(input.limit, 25);
    if (limit <= 0) {
      return errorMessage("limit must be greater than zero");
    }
    const depth = parsePositiveIntegerOrDefault(input.depth, 2);
    if (depth <= 0) {
      return errorMessage("depth must be greater than zero");
    }

    const listed = await listDirSlice(dirPath, offset, limit, depth);
    if (!listed.ok) {
      return errorMessage(listed.error);
    }

    const output = [`Absolute path: ${dirPath}`, ...listed.entries].join("\n");
    return {
      ok: true,
      output,
    };
  },
};

const grepFilesTool: ToolDefinition<GrepFilesInput> = {
  name: "grep_files",
  description: "Finds files whose contents match the pattern and lists them by modification time.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for.",
      },
      include: {
        type: "string",
        description: 'Optional glob that limits which files are searched (e.g. "*.rs" or "*.{ts,tsx}").',
      },
      path: {
        type: "string",
        description: "Directory or file path to search. Defaults to the session's working directory.",
      },
      limit: {
        type: "number",
        description: "Maximum number of file paths to return (defaults to 100).",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  run: async (input) => {
    const pattern = asNonEmptyString(input.pattern);
    if (!pattern) {
      return errorMessage("pattern must not be empty");
    }

    const limitRaw = parsePositiveIntegerOrDefault(input.limit, GREP_DEFAULT_LIMIT);
    if (limitRaw <= 0) {
      return errorMessage("limit must be greater than zero");
    }
    const limit = Math.min(limitRaw, GREP_MAX_LIMIT);

    const requestedPath = asNonEmptyString(input.path);
    const searchPath = requestedPath ? path.resolve(process.cwd(), requestedPath) : process.cwd();
    try {
      await fs.stat(searchPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorMessage(`unable to access \`${searchPath}\`: ${message}`);
    }

    const includeRaw = asNonEmptyString(input.include);
    const include = includeRaw || null;

    const rgResult = await runRgSearch({
      pattern,
      include,
      searchPath,
      limit,
      cwd: process.cwd(),
    });
    if (!rgResult.ok) {
      return errorMessage(rgResult.error);
    }

    if (rgResult.results.length === 0) {
      return {
        ok: false,
        output: "No matches found.",
      };
    }

    return {
      ok: true,
      output: rgResult.results.join("\n"),
    };
  },
};

const applyPatchTool: ToolDefinition<ApplyPatchInput> = {
  name: "apply_patch",
  description:
    "Use the `apply_patch` tool to edit files. Your input should be the full patch text (*** Begin Patch ... *** End Patch).",
  inputSchema: {
    type: "object",
    properties: {
      input: {
        type: "string",
        description: "The entire contents of the apply_patch command",
      },
    },
    required: ["input"],
    additionalProperties: false,
  },
  run: async (input) => {
    const patchInput = asNonEmptyString(input.input);
    if (!patchInput) {
      return invalidInput("apply_patch requires non-empty `input` patch text.");
    }

    const parsed = parsePatchText(patchInput);
    if (!parsed.ok) {
      return errorMessage(parsed.error);
    }

    const applied = await applyPatchHunks(parsed.hunks, process.cwd());
    if (!applied.ok) {
      return errorMessage(applied.error);
    }

    return {
      ok: true,
      output: formatPatchSummary(applied.summary),
    };
  },
};

export const FILE_OPS_BUILTIN_TOOLS: ToolDefinition[] = [
  applyPatchTool,
  grepFilesTool,
  listDirTool,
  readFileTool,
];

function asNonEmptyString(value: JsonValue | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveIntegerOrDefault(value: JsonValue | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const integer = Math.floor(value);
  return integer;
}

function parseBooleanOrDefault(value: JsonValue | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function normalizeReadMode(value: JsonValue | undefined): ReadMode {
  if (typeof value !== "string") {
    return "slice";
  }
  return value.trim().toLowerCase() === "indentation" ? "indentation" : "slice";
}

function parseIndentationOptions(value: JsonValue | undefined): IndentationOptions {
  if (!isRecord(value)) {
    return {
      anchorLine: null,
      maxLevels: 0,
      includeSiblings: false,
      includeHeader: true,
      maxLines: null,
    };
  }

  const anchorLineRaw = parsePositiveIntegerOrDefault(value.anchor_line, 0);
  const maxLevels = Math.max(0, parsePositiveIntegerOrDefault(value.max_levels, 0));
  const maxLinesRaw = parsePositiveIntegerOrDefault(value.max_lines, 0);

  return {
    anchorLine: anchorLineRaw > 0 ? anchorLineRaw : null,
    maxLevels,
    includeSiblings: parseBooleanOrDefault(value.include_siblings, false),
    includeHeader: parseBooleanOrDefault(value.include_header, true),
    maxLines: maxLinesRaw > 0 ? maxLinesRaw : null,
  };
}

async function readUtf8Lines(filePath: string): Promise<
  | { ok: true; lines: string[] }
  | {
      ok: false;
      error: string;
    }
> {
  try {
    const buffer = await fs.readFile(filePath);
    return {
      ok: true,
      lines: splitTextToLines(buffer.toString("utf8")),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function splitTextToLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function buildLineRecords(lines: string[]): LineRecord[] {
  const records: LineRecord[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? "";
    records.push({
      number: i + 1,
      raw,
      display: truncateText(raw, MAX_LINE_LENGTH),
      indent: measureIndent(raw),
    });
  }
  return records;
}

function runSliceRead(records: LineRecord[], offset: number, limit: number): ToolResult<string> {
  if (records.length < offset) {
    return errorMessage("offset exceeds file length");
  }

  const start = offset - 1;
  const selected = records.slice(start, start + limit).map((record) => formatLineRecord(record));
  return {
    ok: true,
    output: selected.join("\n"),
  };
}

function runIndentationRead(
  records: LineRecord[],
  input: {
    offset: number;
    limit: number;
    indentation: IndentationOptions;
  },
): ToolResult<string> {
  const anchorLine = input.indentation.anchorLine ?? input.offset;
  if (anchorLine <= 0) {
    return errorMessage("anchor_line must be a 1-indexed line number");
  }
  if (records.length === 0 || anchorLine > records.length) {
    return errorMessage("anchor_line exceeds file length");
  }

  const guardLimit = input.indentation.maxLines ?? input.limit;
  if (guardLimit <= 0) {
    return errorMessage("max_lines must be greater than zero");
  }

  const anchorIndex = anchorLine - 1;
  const effectiveIndents = computeEffectiveIndents(records);
  const anchorIndent = effectiveIndents[anchorIndex] ?? 0;
  const minIndent =
    input.indentation.maxLevels === 0
      ? 0
      : Math.max(0, anchorIndent - input.indentation.maxLevels * TAB_WIDTH);
  const finalLimit = Math.min(input.limit, guardLimit, records.length);

  if (finalLimit === 1) {
    const only = records[anchorIndex];
    return {
      ok: true,
      output: only ? formatLineRecord(only) : "",
    };
  }

  let upIndex = anchorIndex - 1;
  let downIndex = anchorIndex + 1;
  let upMinIndentCount = 0;
  let downMinIndentCount = 0;
  const output: LineRecord[] = [];
  const anchorRecord = records[anchorIndex];
  if (anchorRecord) {
    output.push(anchorRecord);
  }

  while (output.length < finalLimit) {
    let progressed = 0;

    if (upIndex >= 0) {
      const upRecord = records[upIndex];
      const upIndent = effectiveIndents[upIndex] ?? 0;
      if (upRecord && upIndent >= minIndent) {
        output.unshift(upRecord);
        progressed += 1;
        upIndex -= 1;

        if (upIndent === minIndent && !input.indentation.includeSiblings) {
          const allowHeaderComment = input.indentation.includeHeader && isCommentLine(upRecord);
          const canTakeLine = allowHeaderComment || upMinIndentCount === 0;
          if (canTakeLine) {
            upMinIndentCount += 1;
          } else {
            output.shift();
            progressed -= 1;
            upIndex = -1;
          }
        }

        if (output.length >= finalLimit) {
          break;
        }
      } else {
        upIndex = -1;
      }
    }

    if (downIndex < records.length) {
      const downRecord = records[downIndex];
      const downIndent = effectiveIndents[downIndex] ?? 0;
      if (downRecord && downIndent >= minIndent) {
        output.push(downRecord);
        progressed += 1;
        downIndex += 1;

        if (downIndent === minIndent && !input.indentation.includeSiblings) {
          if (downMinIndentCount > 0) {
            output.pop();
            progressed -= 1;
            downIndex = records.length;
          }
          downMinIndentCount += 1;
        }
      } else {
        downIndex = records.length;
      }
    }

    if (progressed === 0) {
      break;
    }
  }

  trimEmptyLineRecords(output);
  return {
    ok: true,
    output: output.map((line) => formatLineRecord(line)).join("\n"),
  };
}

function computeEffectiveIndents(records: LineRecord[]): number[] {
  const effective: number[] = [];
  let previous = 0;
  for (const record of records) {
    if (record.raw.trim().length === 0) {
      effective.push(previous);
      continue;
    }
    previous = record.indent;
    effective.push(previous);
  }
  return effective;
}

function trimEmptyLineRecords(records: LineRecord[]): void {
  while (records.length > 0 && records[0]?.raw.trim() === "") {
    records.shift();
  }
  while (records.length > 0 && records[records.length - 1]?.raw.trim() === "") {
    records.pop();
  }
}

function formatLineRecord(record: LineRecord): string {
  return `L${record.number}: ${record.display}`;
}

function isCommentLine(record: LineRecord): boolean {
  const trimmed = record.raw.trim();
  return READ_FILE_COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function measureIndent(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === " ") {
      count += 1;
      continue;
    }
    if (char === "\t") {
      count += TAB_WIDTH;
      continue;
    }
    break;
  }
  return count;
}

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return Array.from(input).slice(0, maxChars).join("");
}

async function listDirSlice(
  rootPath: string,
  offset: number,
  limit: number,
  depth: number,
): Promise<
  | { ok: true; entries: string[] }
  | {
      ok: false;
      error: string;
    }
> {
  const entries: DirEntryRecord[] = [];
  const queue: Array<{ currentDir: string; relativePrefix: string; remainingDepth: number }> = [
    {
      currentDir: rootPath,
      relativePrefix: "",
      remainingDepth: depth,
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    let children: Array<import("node:fs").Dirent>;
    try {
      children = await fs.readdir(current.currentDir, {
        withFileTypes: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `failed to read directory: ${message}`,
      };
    }

    const mapped: Array<{
      absolutePath: string;
      relativePath: string;
      kind: DirEntryKind;
      entry: DirEntryRecord;
    }> = [];

    for (const child of children) {
      const relativePath = current.relativePrefix
        ? path.join(current.relativePrefix, child.name)
        : child.name;
      const displayDepth = current.relativePrefix
        ? current.relativePrefix.split(path.sep).filter(Boolean).length
        : 0;
      const kind = classifyDirEntryKind(child);
      const sortKey = normalizePathForDisplay(relativePath);
      mapped.push({
        absolutePath: path.join(current.currentDir, child.name),
        relativePath,
        kind,
        entry: {
          name: sortKey,
          displayName: truncateText(child.name, MAX_ENTRY_LENGTH),
          depth: displayDepth,
          kind,
        },
      });
    }

    mapped.sort((left, right) => left.entry.name.localeCompare(right.entry.name));

    for (const item of mapped) {
      if (item.kind === "directory" && current.remainingDepth > 1) {
        queue.push({
          currentDir: item.absolutePath,
          relativePrefix: item.relativePath,
          remainingDepth: current.remainingDepth - 1,
        });
      }
      entries.push(item.entry);
    }
  }

  if (entries.length === 0) {
    return {
      ok: true,
      entries: [],
    };
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));

  const startIndex = offset - 1;
  if (startIndex >= entries.length) {
    return {
      ok: false,
      error: "offset exceeds directory entry count",
    };
  }

  const remainingEntries = entries.length - startIndex;
  const cappedLimit = Math.min(limit, remainingEntries);
  const endIndex = startIndex + cappedLimit;
  const selected = entries.slice(startIndex, endIndex);
  const formatted = selected.map((entry) => formatDirEntryLine(entry));
  if (endIndex < entries.length) {
    formatted.push(`More than ${cappedLimit} entries found`);
  }

  return {
    ok: true,
    entries: formatted,
  };
}

function classifyDirEntryKind(entry: import("node:fs").Dirent): DirEntryKind {
  if (entry.isSymbolicLink()) {
    return "symlink";
  }
  if (entry.isDirectory()) {
    return "directory";
  }
  if (entry.isFile()) {
    return "file";
  }
  return "other";
}

function normalizePathForDisplay(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  return truncateText(normalized, MAX_ENTRY_LENGTH);
}

function formatDirEntryLine(entry: DirEntryRecord): string {
  const indent = " ".repeat(entry.depth * LIST_DIR_INDENTATION_SPACES);
  let suffix = "";
  if (entry.kind === "directory") {
    suffix = "/";
  } else if (entry.kind === "symlink") {
    suffix = "@";
  } else if (entry.kind === "other") {
    suffix = "?";
  }
  return `${indent}${entry.displayName}${suffix}`;
}

async function runRgSearch(input: {
  pattern: string;
  include: string | null;
  searchPath: string;
  limit: number;
  cwd: string;
}): Promise<
  | { ok: true; results: string[] }
  | {
      ok: false;
      error: string;
    }
> {
  const args = [
    "--files-with-matches",
    "--sortr=modified",
    "--regexp",
    input.pattern,
    "--no-messages",
  ];
  if (input.include) {
    args.push("--glob", input.include);
  }
  args.push("--", input.searchPath);

  const commandResult = await runChildCommand("rg", args, {
    cwd: input.cwd,
    timeoutMs: GREP_COMMAND_TIMEOUT_MS,
  });

  if (!commandResult.ok) {
    return {
      ok: false,
      error: commandResult.error,
    };
  }

  if (commandResult.exitCode === 1) {
    return {
      ok: true,
      results: [],
    };
  }
  if (commandResult.exitCode !== 0) {
    const stderr = commandResult.stderr.trim();
    return {
      ok: false,
      error: `rg failed: ${stderr || `exit code ${commandResult.exitCode ?? "unknown"}`}`,
    };
  }

  const results: string[] = [];
  for (const row of commandResult.stdout.split("\n")) {
    const trimmed = row.trim();
    if (!trimmed) {
      continue;
    }
    results.push(trimmed);
    if (results.length >= input.limit) {
      break;
    }
  }

  return {
    ok: true,
    results,
  };
}

async function runChildCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
  },
): Promise<
  | {
      ok: true;
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }
  | {
      ok: false;
      error: string;
    }
> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: Error | null = null;

    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_500).unref();
    }, options.timeoutMs);

    child.on("close", (exitCode) => {
      clearTimeout(timeoutHandle);
      if (timedOut) {
        resolve({
          ok: false,
          error: "rg timed out after 30 seconds",
        });
        return;
      }
      if (spawnError) {
        resolve({
          ok: false,
          error: `failed to launch rg: ${spawnError.message}. Ensure ripgrep is installed and on PATH.`,
        });
        return;
      }
      resolve({
        ok: true,
        stdout,
        stderr,
        exitCode,
      });
    });
  });
}

function parsePatchText(
  patchText: string,
): { ok: true; hunks: PatchHunk[] } | { ok: false; error: string } {
  const rawLines = patchText.trim().split(/\r?\n/);
  const bounded = checkPatchBoundaries(rawLines);
  if (!bounded.ok) {
    return bounded;
  }

  const patchLines = bounded.lines;
  const hunks: PatchHunk[] = [];
  const body = patchLines.slice(1, patchLines.length - 1);
  let lineNumber = 2;
  let remaining = body;

  while (remaining.length > 0) {
    const parsed = parseOnePatchHunk(remaining, lineNumber);
    if (!parsed.ok) {
      return parsed;
    }
    hunks.push(parsed.hunk);
    remaining = remaining.slice(parsed.parsedLines);
    lineNumber += parsed.parsedLines;
  }

  return {
    ok: true,
    hunks,
  };
}

function checkPatchBoundaries(
  lines: string[],
): { ok: true; lines: string[] } | { ok: false; error: string } {
  const strict = checkPatchBoundariesStrict(lines);
  if (strict.ok) {
    return strict;
  }

  if (lines.length >= 4) {
    const first = lines[0];
    const last = lines[lines.length - 1];
    if (
      (first === "<<EOF" || first === "<<'EOF'" || first === "<<\"EOF\"") &&
      typeof last === "string" &&
      last.endsWith("EOF")
    ) {
      const inner = lines.slice(1, -1);
      return checkPatchBoundariesStrict(inner);
    }
  }

  return strict;
}

function checkPatchBoundariesStrict(
  lines: string[],
): { ok: true; lines: string[] } | { ok: false; error: string } {
  const first = lines[0]?.trim();
  const last = lines[lines.length - 1]?.trim();
  if (first === PATCH_BEGIN_MARKER && last === PATCH_END_MARKER) {
    return {
      ok: true,
      lines,
    };
  }
  if (first !== PATCH_BEGIN_MARKER) {
    return {
      ok: false,
      error: "invalid patch: The first line of the patch must be '*** Begin Patch'",
    };
  }
  return {
    ok: false,
    error: "invalid patch: The last line of the patch must be '*** End Patch'",
  };
}

function parseOnePatchHunk(
  lines: string[],
  lineNumber: number,
):
  | { ok: true; hunk: PatchHunk; parsedLines: number }
  | {
      ok: false;
      error: string;
    } {
  const firstLine = (lines[0] ?? "").trim();
  const addPath = firstLine.startsWith(PATCH_ADD_FILE_MARKER)
    ? firstLine.slice(PATCH_ADD_FILE_MARKER.length)
    : null;
  if (addPath !== null) {
    let parsedLines = 1;
    let contents = "";
    for (const line of lines.slice(1)) {
      if (!line.startsWith("+")) {
        break;
      }
      contents += `${line.slice(1)}\n`;
      parsedLines += 1;
    }
    return {
      ok: true,
      parsedLines,
      hunk: {
        type: "add_file",
        filePath: addPath,
        contents,
      },
    };
  }

  const deletePath = firstLine.startsWith(PATCH_DELETE_FILE_MARKER)
    ? firstLine.slice(PATCH_DELETE_FILE_MARKER.length)
    : null;
  if (deletePath !== null) {
    return {
      ok: true,
      parsedLines: 1,
      hunk: {
        type: "delete_file",
        filePath: deletePath,
      },
    };
  }

  const updatePath = firstLine.startsWith(PATCH_UPDATE_FILE_MARKER)
    ? firstLine.slice(PATCH_UPDATE_FILE_MARKER.length)
    : null;
  if (updatePath !== null) {
    let remaining = lines.slice(1);
    let parsedLines = 1;
    let movePath: string | null = null;

    const maybeMove = remaining[0];
    if (typeof maybeMove === "string" && maybeMove.startsWith(PATCH_MOVE_TO_MARKER)) {
      movePath = maybeMove.slice(PATCH_MOVE_TO_MARKER.length);
      remaining = remaining.slice(1);
      parsedLines += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      const next = remaining[0] ?? "";
      if (next.trim().length === 0) {
        remaining = remaining.slice(1);
        parsedLines += 1;
        continue;
      }
      if (next.startsWith("***")) {
        break;
      }

      const chunk = parseUpdateFileChunk(remaining, lineNumber + parsedLines, chunks.length === 0);
      if (!chunk.ok) {
        return chunk;
      }
      chunks.push(chunk.chunk);
      remaining = remaining.slice(chunk.parsedLines);
      parsedLines += chunk.parsedLines;
    }

    if (chunks.length === 0) {
      return {
        ok: false,
        error: `invalid hunk at line ${lineNumber}, Update file hunk for path '${updatePath}' is empty`,
      };
    }

    return {
      ok: true,
      parsedLines,
      hunk: {
        type: "update_file",
        filePath: updatePath,
        movePath,
        chunks,
      },
    };
  }

  return {
    ok: false,
    error: `invalid hunk at line ${lineNumber}, '${firstLine}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  };
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
):
  | { ok: true; chunk: UpdateFileChunk; parsedLines: number }
  | {
      ok: false;
      error: string;
    } {
  if (lines.length === 0) {
    return {
      ok: false,
      error: `invalid hunk at line ${lineNumber}, Update hunk does not contain any lines`,
    };
  }

  let changeContext: string | null = null;
  let startIndex = 0;
  const first = lines[0] ?? "";
  if (first === PATCH_EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (first.startsWith(PATCH_CHANGE_CONTEXT_MARKER)) {
    changeContext = first.slice(PATCH_CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    return {
      ok: false,
      error: `invalid hunk at line ${lineNumber}, Expected update hunk to start with a @@ context marker, got: '${first}'`,
    };
  }

  if (startIndex >= lines.length) {
    return {
      ok: false,
      error: `invalid hunk at line ${lineNumber + 1}, Update hunk does not contain any lines`,
    };
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };
  let parsedLines = 0;

  for (const line of lines.slice(startIndex)) {
    if (line === PATCH_EOF_MARKER) {
      if (parsedLines === 0) {
        return {
          ok: false,
          error: `invalid hunk at line ${lineNumber + 1}, Update hunk does not contain any lines`,
        };
      }
      chunk.isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const marker = line.charAt(0);
    if (line.length === 0) {
      chunk.oldLines.push("");
      chunk.newLines.push("");
      parsedLines += 1;
      continue;
    }
    if (marker === " ") {
      chunk.oldLines.push(line.slice(1));
      chunk.newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (marker === "+") {
      chunk.newLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (marker === "-") {
      chunk.oldLines.push(line.slice(1));
      parsedLines += 1;
      continue;
    }
    if (parsedLines === 0) {
      return {
        ok: false,
        error: `invalid hunk at line ${lineNumber + 1}, Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      };
    }
    break;
  }

  return {
    ok: true,
    chunk,
    parsedLines: parsedLines + startIndex,
  };
}

async function applyPatchHunks(
  hunks: PatchHunk[],
  cwd: string,
): Promise<
  | {
      ok: true;
      summary: {
        added: string[];
        modified: string[];
        deleted: string[];
      };
    }
  | {
      ok: false;
      error: string;
    }
> {
  if (hunks.length === 0) {
    return {
      ok: false,
      error: "No files were modified.",
    };
  }

  const summary = {
    added: [] as string[],
    modified: [] as string[],
    deleted: [] as string[],
  };

  for (const hunk of hunks) {
    if (hunk.type === "add_file") {
      const destination = resolvePatchPath(hunk.filePath, cwd);
      try {
        const parent = path.dirname(destination);
        if (parent && parent !== ".") {
          await fs.mkdir(parent, {
            recursive: true,
          });
        }
        await fs.writeFile(destination, hunk.contents, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Failed to write file ${destination}: ${message}`,
        };
      }
      summary.added.push(destination);
      continue;
    }

    if (hunk.type === "delete_file") {
      const target = resolvePatchPath(hunk.filePath, cwd);
      try {
        await fs.rm(target);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Failed to delete file ${target}: ${message}`,
        };
      }
      summary.deleted.push(target);
      continue;
    }

    const source = resolvePatchPath(hunk.filePath, cwd);
    const derived = await deriveUpdatedFileContents(source, hunk.chunks);
    if (!derived.ok) {
      return derived;
    }

    if (hunk.movePath) {
      const destination = resolvePatchPath(hunk.movePath, cwd);
      try {
        const parent = path.dirname(destination);
        if (parent && parent !== ".") {
          await fs.mkdir(parent, {
            recursive: true,
          });
        }
        await fs.writeFile(destination, derived.newContents, "utf8");
        await fs.rm(source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Failed to write file ${destination}: ${message}`,
        };
      }
      summary.modified.push(destination);
      continue;
    }

    try {
      await fs.writeFile(source, derived.newContents, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: `Failed to write file ${source}: ${message}`,
      };
    }
    summary.modified.push(source);
  }

  return {
    ok: true,
    summary,
  };
}

function resolvePatchPath(filePath: string, cwd: string): string {
  return path.resolve(cwd, filePath);
}

async function deriveUpdatedFileContents(
  targetPath: string,
  chunks: UpdateFileChunk[],
): Promise<{ ok: true; newContents: string } | { ok: false; error: string }> {
  let originalContents: string;
  try {
    originalContents = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Failed to read file to update ${targetPath}: ${message}`,
    };
  }

  const originalLines = originalContents.split("\n");
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  const replacements = computePatchReplacements(originalLines, targetPath, chunks);
  if (!replacements.ok) {
    return replacements;
  }

  const updatedLines = applyReplacements(originalLines, replacements.replacements);
  if (updatedLines.length === 0 || updatedLines[updatedLines.length - 1] !== "") {
    updatedLines.push("");
  }

  return {
    ok: true,
    newContents: updatedLines.join("\n"),
  };
}

function computePatchReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): { ok: true; replacements: ReplacementRecord[] } | { ok: false; error: string } {
  const replacements: ReplacementRecord[] = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const contextIndex = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (contextIndex === null) {
        return {
          ok: false,
          error: `Failed to find context '${chunk.changeContext}' in ${filePath}`,
        };
      }
      lineIndex = contextIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      const insertionIndex =
        originalLines.length > 0 && originalLines[originalLines.length - 1] === ""
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push({
        startIndex: insertionIndex,
        oldLength: 0,
        newLines: [...chunk.newLines],
      });
      continue;
    }

    let pattern = [...chunk.oldLines];
    let newSlice = [...chunk.newLines];
    let foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    if (foundAt === null && pattern.length > 0 && pattern[pattern.length - 1] === "") {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === "") {
        newSlice = newSlice.slice(0, -1);
      }
      foundAt = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (foundAt === null) {
      return {
        ok: false,
        error: `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join("\n")}`,
      };
    }

    replacements.push({
      startIndex: foundAt,
      oldLength: pattern.length,
      newLines: [...newSlice],
    });
    lineIndex = foundAt + pattern.length;
  }

  replacements.sort((left, right) => left.startIndex - right.startIndex);
  return {
    ok: true,
    replacements,
  };
}

function applyReplacements(lines: string[], replacements: ReplacementRecord[]): string[] {
  const next = [...lines];
  for (let i = replacements.length - 1; i >= 0; i -= 1) {
    const current = replacements[i];
    if (!current) {
      continue;
    }
    next.splice(current.startIndex, current.oldLength, ...current.newLines);
  }
  return next;
}

function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null {
  if (pattern.length === 0) {
    return start;
  }
  if (pattern.length > lines.length) {
    return null;
  }

  const maxStart = lines.length - pattern.length;
  const searchStart = eof && lines.length >= pattern.length ? lines.length - pattern.length : start;
  if (searchStart > maxStart) {
    return null;
  }
  const fromIndex = Math.max(0, searchStart);

  for (let i = fromIndex; i <= maxStart; i += 1) {
    if (matchesPattern(lines, pattern, i, "exact")) {
      return i;
    }
  }
  for (let i = fromIndex; i <= maxStart; i += 1) {
    if (matchesPattern(lines, pattern, i, "trim_end")) {
      return i;
    }
  }
  for (let i = fromIndex; i <= maxStart; i += 1) {
    if (matchesPattern(lines, pattern, i, "trim")) {
      return i;
    }
  }
  for (let i = fromIndex; i <= maxStart; i += 1) {
    if (matchesPattern(lines, pattern, i, "normalize")) {
      return i;
    }
  }

  return null;
}

function matchesPattern(
  lines: string[],
  pattern: string[],
  start: number,
  mode: "exact" | "trim_end" | "trim" | "normalize",
): boolean {
  for (let index = 0; index < pattern.length; index += 1) {
    const line = lines[start + index] ?? "";
    const expected = pattern[index] ?? "";

    if (mode === "exact" && line !== expected) {
      return false;
    }
    if (mode === "trim_end" && line.trimEnd() !== expected.trimEnd()) {
      return false;
    }
    if (mode === "trim" && line.trim() !== expected.trim()) {
      return false;
    }
    if (mode === "normalize" && normalizePatchComparison(line) !== normalizePatchComparison(expected)) {
      return false;
    }
  }
  return true;
}

function normalizePatchComparison(value: string): string {
  return value
    .trim()
    .split("")
    .map((char) => {
      if (
        char === "\u2010" ||
        char === "\u2011" ||
        char === "\u2012" ||
        char === "\u2013" ||
        char === "\u2014" ||
        char === "\u2015" ||
        char === "\u2212"
      ) {
        return "-";
      }
      if (char === "\u2018" || char === "\u2019" || char === "\u201A" || char === "\u201B") {
        return "'";
      }
      if (char === "\u201C" || char === "\u201D" || char === "\u201E" || char === "\u201F") {
        return "\"";
      }
      if (
        char === "\u00A0" ||
        char === "\u2002" ||
        char === "\u2003" ||
        char === "\u2004" ||
        char === "\u2005" ||
        char === "\u2006" ||
        char === "\u2007" ||
        char === "\u2008" ||
        char === "\u2009" ||
        char === "\u200A" ||
        char === "\u202F" ||
        char === "\u205F" ||
        char === "\u3000"
      ) {
        return " ";
      }
      return char;
    })
    .join("");
}

function formatPatchSummary(summary: { added: string[]; modified: string[]; deleted: string[] }): string {
  const lines = ["Success. Updated the following files:"];
  for (const filePath of summary.added) {
    lines.push(`A ${filePath}`);
  }
  for (const filePath of summary.modified) {
    lines.push(`M ${filePath}`);
  }
  for (const filePath of summary.deleted) {
    lines.push(`D ${filePath}`);
  }
  return lines.join("\n");
}

function invalidInput(message: string): ToolResult<string> {
  return {
    ok: false,
    output: message,
    error: message,
  };
}

function errorMessage(message: string): ToolResult<string> {
  return {
    ok: false,
    output: message,
    error: message,
  };
}
