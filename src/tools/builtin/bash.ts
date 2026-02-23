import { spawn as spawnProcess } from "node:child_process";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { JsonValue, ToolDefinition, ToolInput, ToolResult } from "../types.js";

type BashInput = ToolInput & {
  command?: JsonValue;
  timeout_seconds?: JsonValue;
  cwd?: JsonValue;
  env?: JsonValue;
  reset_session?: JsonValue;
  run_in_background?: JsonValue;
  session_name?: JsonValue;
  reuse_session?: JsonValue;
  full_terminal?: JsonValue;
  terminal_cols?: JsonValue;
  terminal_rows?: JsonValue;
};

type ReadBackgroundBashInput = ToolInput & {
  session_id?: JsonValue;
  max_chars?: JsonValue;
  stream?: JsonValue;
  peek?: JsonValue;
};

type WriteBackgroundBashInput = ToolInput & {
  session_id?: JsonValue;
  input?: JsonValue;
  key?: JsonValue;
  repeat?: JsonValue;
  append_newline?: JsonValue;
};

type StopBackgroundBashInput = ToolInput & {
  session_id?: JsonValue;
  force?: JsonValue;
};

type ListBackgroundBashInput = ToolInput & {
  include_exited?: JsonValue;
};

type ResizeBackgroundBashInput = ToolInput & {
  session_id?: JsonValue;
  cols?: JsonValue;
  rows?: JsonValue;
};

type ProcessRunResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  ok: boolean;
};

type ResolvedShell = {
  shell: "zsh" | "bash" | "sh" | "powershell" | "cmd";
  command: string;
  argsForCommand: (wrappedCommand: string) => string[];
  wrapCommand: (command: string, markerPrefix: string) => string;
};

type ParsedStateCapture = {
  cleanedStdout: string;
  cwdAfter: string | null;
  envAfter: NodeJS.ProcessEnv | null;
  stateCaptured: boolean;
};

type BackgroundStreamSelector = "both" | "stdout" | "stderr";

type BackgroundStreamState = {
  buffer: string;
  totalChars: number;
  droppedChars: number;
  readCursor: number;
};

type BackgroundBashSessionStatus = "running" | "exited";

type BackgroundBashSession = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  shell: ResolvedShell["shell"];
  shellCommand: string;
  shellArgs: string[];
  commandText: string;
  pid: number | null;
  status: BackgroundBashSessionStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: BackgroundStreamState;
  stderr: BackgroundStreamState;
  child: ReturnType<typeof spawnProcess> | null;
  pty: IPty | null;
  transport: "pipe" | "pty";
  fullTerminal: boolean;
  terminalCols: number;
  terminalRows: number;
};

export type BackgroundBashSessionSnapshot = {
  session_id: string;
  session_name: string;
  running: boolean;
  status: BackgroundBashSessionStatus;
  shell: ResolvedShell["shell"];
  command: string;
  cwd: string;
  created_at: string;
  updated_at: string;
  unread_stdout_chars: number;
  unread_stderr_chars: number;
  transport: "pipe" | "pty";
  full_terminal: boolean;
  terminal_cols: number;
  terminal_rows: number;
};

const MAX_CAPTURE_CHARS = 300_000;
const MAX_BACKGROUND_CAPTURE_CHARS = 300_000;
const DEFAULT_BACKGROUND_READ_CHARS = 8_000;
const MAX_BACKGROUND_READ_CHARS = 120_000;
const DEFAULT_TERMINAL_COLS = 120;
const DEFAULT_TERMINAL_ROWS = 36;
const MIN_TERMINAL_COLS = 40;
const MIN_TERMINAL_ROWS = 10;
const MAX_TERMINAL_COLS = 400;
const MAX_TERMINAL_ROWS = 200;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 60 * 20;
const COMMAND_DETECTION_TIMEOUT_MS = 8_000;
const commandAvailabilityCache = new Map<string, Promise<boolean>>();
const backgroundBashSessions = new Map<string, BackgroundBashSession>();
let backgroundBashCleanupInstalled = false;
const SPECIAL_KEY_SEQUENCES: Record<string, string> = {
  enter: "\r",
  tab: "\t",
  esc: "\u001b",
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
  home: "\u001b[H",
  end: "\u001b[F",
  pgup: "\u001b[5~",
  pgdown: "\u001b[6~",
  backspace: "\u007f",
  delete: "\u001b[3~",
  "ctrl+c": "\u0003",
  "ctrl+d": "\u0004",
  "ctrl+z": "\u001a",
};

let bashSessionState: {
  cwd: string;
  env: NodeJS.ProcessEnv;
} = createDefaultSessionState();

const bashTool: ToolDefinition<BashInput> = {
  name: "bash",
  description:
    "run shell commands with login-shell semantics and persist cwd/env across tool calls in this loaf session.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "shell command text to execute.",
      },
      timeout_seconds: {
        type: "number",
        description: "optional timeout in seconds (default 120, max 1200).",
      },
      cwd: {
        type: "string",
        description: "optional starting cwd for this command (also updates tool session cwd baseline).",
      },
      env: {
        type: "object",
        description: "optional environment variable overrides for this command (persisted in tool session).",
        additionalProperties: { type: "string" },
      },
      reset_session: {
        type: "boolean",
        description: "reset persisted bash tool cwd/env state before execution.",
      },
      run_in_background: {
        type: "boolean",
        description: "when true, start command asynchronously and return a background session id.",
      },
      session_name: {
        type: "string",
        description: "optional friendly name for a background bash session.",
      },
      reuse_session: {
        type: "boolean",
        description:
          "when run_in_background is true, reuse an existing running session with same session_name and cwd. default true.",
      },
      full_terminal: {
        type: "boolean",
        description:
          "when run_in_background is true, use a PTY terminal transport so TUIs/installers and key navigation work. default true.",
      },
      terminal_cols: {
        type: "number",
        description: "PTY columns when full_terminal=true (default 120).",
      },
      terminal_rows: {
        type: "number",
        description: "PTY rows when full_terminal=true (default 36).",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  run: async (input, context): Promise<ToolResult> => {
    const commandText = asNonEmptyString(input.command);
    if (!commandText) {
      return invalidInput("bash requires a non-empty `command` string.");
    }

    const timeoutMs = parseTimeoutMs(input.timeout_seconds);
    const runInBackground = asBoolean(input.run_in_background);
    const resetSession = asBoolean(input.reset_session);
    if (resetSession) {
      bashSessionState = createDefaultSessionState();
    }

    const envOverrides = parseEnvOverrides(input.env);
    if (!envOverrides.ok) {
      return invalidInput(envOverrides.error);
    }

    const cwdOverride = asNonEmptyString(input.cwd);
    const cwdBefore = cwdOverride || bashSessionState.cwd || process.cwd();
    const envBefore: NodeJS.ProcessEnv = {
      ...bashSessionState.env,
      ...envOverrides.value,
    };

    // cwd/env overrides become the new baseline for subsequent bash tool calls.
    bashSessionState.cwd = cwdBefore;
    bashSessionState.env = { ...envBefore };

    const shell = await resolveShellRuntime();
    if (!shell) {
      const message =
        "bash could not resolve an available shell runtime (tried zsh/bash/sh on unix, powershell/cmd on windows).";
      return {
        ok: false,
        output: {
          status: "error",
          mode: "bash",
          command: commandText,
          cwd_before: cwdBefore,
          cwd_after: bashSessionState.cwd,
          session_updated: true,
        },
        error: message,
      };
    }

    if (runInBackground) {
      const sessionNameRaw = asNonEmptyString(input.session_name);
      const sessionName = sessionNameRaw || "background-bash";
      const reuseSession = input.reuse_session === undefined ? true : asBoolean(input.reuse_session);
      const fullTerminal = input.full_terminal === undefined ? true : asBoolean(input.full_terminal);
      const terminalCols = parseTerminalDimension(input.terminal_cols, DEFAULT_TERMINAL_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
      const terminalRows = parseTerminalDimension(input.terminal_rows, DEFAULT_TERMINAL_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);

      if (reuseSession && sessionNameRaw) {
        const existing = findRunningBackgroundBashSession(sessionNameRaw, cwdBefore, fullTerminal);
        if (existing) {
          return {
            ok: true,
            output: {
              status: "reused",
              mode: "bash",
              session_id: existing.id,
              session_name: existing.name,
              shell: existing.shell,
              shell_command: existing.shellCommand,
              shell_args: [...existing.shellArgs],
              command: existing.commandText,
              pid: existing.pid,
              cwd: existing.cwd,
              created_at: existing.createdAt,
              updated_at: existing.updatedAt,
              transport: existing.transport,
              full_terminal: existing.fullTerminal,
              terminal_cols: existing.terminalCols,
              terminal_rows: existing.terminalRows,
            },
          };
        }
      }

      ensureBackgroundBashCleanupHook();
      const shellArgs = shell.argsForCommand(commandText);
      const sessionId = createBackgroundBashSessionId();
      const now = new Date().toISOString();
      const session: BackgroundBashSession = {
        id: sessionId,
        name: sessionName,
        createdAt: now,
        updatedAt: now,
        cwd: cwdBefore,
        shell: shell.shell,
        shellCommand: shell.command,
        shellArgs: [...shellArgs],
        commandText,
        pid: null,
        status: "running",
        exitCode: null,
        signal: null,
        stdout: createBackgroundStreamState(),
        stderr: createBackgroundStreamState(),
        child: null,
        pty: null,
        transport: "pipe",
        fullTerminal: false,
        terminalCols,
        terminalRows,
      };

      if (fullTerminal) {
        try {
          const ptyEnv = buildPtyEnvironment(envBefore);
          const pty = spawnPty(shell.command, shellArgs, {
            cwd: cwdBefore,
            env: ptyEnv,
            cols: terminalCols,
            rows: terminalRows,
            name: process.platform === "win32" ? "xterm-256color" : "xterm-color",
          });

          session.pty = pty;
          session.transport = "pty";
          session.fullTerminal = true;
          session.pid = Number.isFinite(pty.pid) ? pty.pid : null;

          pty.onData((chunk) => {
            appendToBackgroundStream(session.stdout, String(chunk));
            session.updatedAt = new Date().toISOString();
          });
          pty.onExit(({ exitCode }) => {
            session.status = "exited";
            session.exitCode = Number.isFinite(exitCode) ? exitCode : null;
            session.signal = null;
            session.updatedAt = new Date().toISOString();
          });
        } catch (error) {
          return {
            ok: false,
            output: {
              status: "error",
              mode: "bash",
              command: commandText,
              cwd_before: cwdBefore,
              cwd_after: bashSessionState.cwd,
              session_updated: true,
            },
            error: `failed to start full_terminal session: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      } else {
        const child = spawnProcess(shell.command, shellArgs, {
          cwd: cwdBefore,
          env: envBefore,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        session.child = child;
        session.transport = "pipe";
        session.fullTerminal = false;
        session.pid = child.pid ?? null;

        child.stdout?.on("data", (chunk) => {
          appendToBackgroundStream(session.stdout, String(chunk));
          session.updatedAt = new Date().toISOString();
        });
        child.stderr?.on("data", (chunk) => {
          appendToBackgroundStream(session.stderr, String(chunk));
          session.updatedAt = new Date().toISOString();
        });
        child.on("error", (error) => {
          appendToBackgroundStream(session.stderr, `[spawn error] ${error.message}\n`);
          session.updatedAt = new Date().toISOString();
        });
        child.on("close", (exitCode, signal) => {
          session.status = "exited";
          session.exitCode = exitCode;
          session.signal = signal;
          session.updatedAt = new Date().toISOString();
        });
      }

      backgroundBashSessions.set(sessionId, session);

      return {
        ok: true,
        output: {
          status: "started",
          mode: "bash",
          session_id: session.id,
          session_name: session.name,
          shell: shell.shell,
          shell_command: shell.command,
          shell_args: shell.argsForCommand("<command>"),
          command: commandText,
          pid: session.pid,
          cwd: session.cwd,
          created_at: session.createdAt,
          updated_at: session.updatedAt,
          session_updated: true,
          cwd_before: cwdBefore,
          cwd_after: bashSessionState.cwd,
          transport: session.transport,
          full_terminal: session.fullTerminal,
          terminal_cols: session.terminalCols,
          terminal_rows: session.terminalRows,
        },
      };
    }

    const markerPrefix = createMarkerPrefix();
    const wrappedCommand = shell.wrapCommand(commandText, markerPrefix);
    const processResult = await runCommand(shell.command, shell.argsForCommand(wrappedCommand), {
      cwd: cwdBefore,
      env: envBefore,
      timeoutMs,
      signal: context.signal,
    });

    const parsed = parseShellStateCapture(processResult.stdout, markerPrefix);
    if (parsed.cwdAfter) {
      bashSessionState.cwd = parsed.cwdAfter;
    }
    if (parsed.envAfter) {
      bashSessionState.env = parsed.envAfter;
    } else {
      bashSessionState.env = { ...envBefore };
    }

    const output: ToolResult["output"] = {
      status: processResult.ok ? "ok" : "error",
      mode: "bash",
      shell: shell.shell,
      shell_command: shell.command,
      shell_args: shell.argsForCommand("<command>"),
      command: commandText,
      exit_code: processResult.exitCode,
      signal: processResult.signal ?? null,
      timed_out: processResult.timedOut,
      aborted: processResult.aborted,
      duration_ms: processResult.durationMs,
      stdout: parsed.cleanedStdout,
      stderr: processResult.stderr,
      truncated_stdout: processResult.truncatedStdout,
      truncated_stderr: processResult.truncatedStderr,
      cwd_before: cwdBefore,
      cwd_after: bashSessionState.cwd,
      state_captured: parsed.stateCaptured,
      session_updated: true,
    };

    return {
      ok: processResult.ok,
      output,
      error: processResult.ok ? undefined : summarizeProcessError(processResult),
    };
  },
};

const readBackgroundBashTool: ToolDefinition<ReadBackgroundBashInput> = {
  name: "read_background_bash",
  description: "read buffered stdout/stderr from a running or exited background bash session.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "session id returned by bash with run_in_background=true.",
      },
      max_chars: {
        type: "number",
        description: "max characters per stream to return (default 8000, max 120000).",
      },
      stream: {
        type: "string",
        description: "stream selector: both, stdout, or stderr. default both.",
      },
      peek: {
        type: "boolean",
        description: "when true, do not advance internal read cursor.",
      },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  run: (input) => {
    const session = getBackgroundBashSession(input.session_id);
    if (!session) {
      return invalidInput("read_background_bash requires a valid `session_id`.");
    }

    const maxChars = parseBackgroundReadChars(input.max_chars);
    const stream = normalizeBackgroundStreamSelector(input.stream);
    const peek = asBoolean(input.peek);
    if (!stream) {
      return invalidInput("`stream` must be one of: both, stdout, stderr.");
    }

    const stdoutRead = stream === "both" || stream === "stdout"
      ? readBackgroundStream(session.stdout, maxChars, peek)
      : createEmptyBackgroundRead(session.stdout.readCursor);
    const stderrRead = stream === "both" || stream === "stderr"
      ? readBackgroundStream(session.stderr, maxChars, peek)
      : createEmptyBackgroundRead(session.stderr.readCursor);
    const stdoutText = sanitizeTerminalOutput(stdoutRead.text);
    const stderrText = sanitizeTerminalOutput(stderrRead.text);

    return {
      ok: true,
      output: {
        status: "ok",
        session_id: session.id,
        session_name: session.name,
        running: session.status === "running",
        exit_code: session.exitCode,
        signal: session.signal ?? null,
        stdout: stdoutText,
        stderr: stderrText,
        stdout_cursor: stdoutRead.cursor,
        stderr_cursor: stderrRead.cursor,
        stdout_has_more: stdoutRead.hasMore,
        stderr_has_more: stderrRead.hasMore,
        stdout_dropped: stdoutRead.dropped,
        stderr_dropped: stderrRead.dropped,
      },
    };
  },
};

const writeBackgroundBashTool: ToolDefinition<WriteBackgroundBashInput> = {
  name: "write_background_bash",
  description: "write text or key input to a running background bash session (works with PTY full_terminal mode).",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "session id returned by bash with run_in_background=true.",
      },
      input: {
        type: "string",
        description: "text to write to stdin.",
      },
      key: {
        type: "string",
        description:
          "optional special key name (enter, tab, esc, up, down, left, right, home, end, pgup, pgdown, backspace, delete, ctrl+c, ctrl+d, ctrl+z).",
      },
      repeat: {
        type: "number",
        description: "repeat key presses when `key` is provided. default 1.",
      },
      append_newline: {
        type: "boolean",
        description: "append newline to input before writing. default true.",
      },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  run: async (input) => {
    const session = getBackgroundBashSession(input.session_id);
    if (!session) {
      return invalidInput("write_background_bash requires a valid `session_id`.");
    }
    if (session.status !== "running") {
      return {
        ok: false,
        output: {
          status: "not_running",
          session_id: session.id,
          running: false,
          exit_code: session.exitCode,
          signal: session.signal ?? null,
          bytes_written: null,
          transport: session.transport,
        },
        error: "background bash session is not running",
      };
    }

    const keyName = asNonEmptyString(input.key);
    const payloadInput = typeof input.input === "string" ? input.input : "";
    const appendNewline = input.append_newline === undefined ? true : asBoolean(input.append_newline);
    let payload = "";

    if (keyName) {
      const repeat = parseRepeatCount(input.repeat);
      const keySequence = resolveSpecialKeySequence(keyName);
      if (!keySequence) {
        return invalidInput(
          "unknown `key`. valid keys: enter, tab, esc, up, down, left, right, home, end, pgup, pgdown, backspace, delete, ctrl+c, ctrl+d, ctrl+z.",
        );
      }
      payload = keySequence.repeat(repeat);
    } else if (payloadInput) {
      payload = appendNewline ? `${payloadInput}\n` : payloadInput;
    } else {
      return invalidInput("write_background_bash requires either `input` text or `key`.");
    }

    const writeResult = await writeToBackgroundSession(session, payload);
    if (!writeResult.ok) {
      return {
        ok: false,
        output: {
          status: "stdin_unavailable",
          session_id: session.id,
          running: session.status === "running",
          exit_code: session.exitCode,
          signal: session.signal ?? null,
          bytes_written: null,
          transport: session.transport,
        },
        error: writeResult.error,
      };
    }

    session.updatedAt = new Date().toISOString();

    return {
      ok: true,
      output: {
        status: "ok",
        session_id: session.id,
        running: session.status === "running",
        exit_code: session.exitCode,
        signal: session.signal ?? null,
        bytes_written: Buffer.byteLength(payload),
        transport: session.transport,
      },
    };
  },
};

const stopBackgroundBashTool: ToolDefinition<StopBackgroundBashInput> = {
  name: "stop_background_bash",
  description: "stop a background bash session.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "session id returned by bash with run_in_background=true.",
      },
      force: {
        type: "boolean",
        description: "when true, send SIGKILL. default false (SIGTERM).",
      },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
  run: async (input) => {
    const session = getBackgroundBashSession(input.session_id);
    if (!session) {
      return invalidInput("stop_background_bash requires a valid `session_id`.");
    }

    if (session.status !== "running") {
      return {
        ok: true,
        output: {
          status: "already_stopped",
          session_id: session.id,
          running: false,
          exit_code: session.exitCode,
          signal: session.signal ?? null,
        },
      };
    }

    const force = asBoolean(input.force);
    const signal: NodeJS.Signals = force ? "SIGKILL" : "SIGTERM";
    if (session.transport === "pty") {
      try {
        session.pty?.kill();
      } catch {
        // best effort
      }
    } else {
      session.child?.kill(signal);
    }
    await sleepMs(force ? 50 : 120);

    return {
      ok: true,
      output: {
        status: "stop_requested",
        session_id: session.id,
        signal,
        running: session.status === "running",
        exit_code: session.exitCode,
      },
    };
  },
};

const resizeBackgroundBashTool: ToolDefinition<ResizeBackgroundBashInput> = {
  name: "resize_background_bash",
  description: "resize terminal dimensions for a running PTY-backed background bash session.",
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "session id returned by bash with run_in_background=true.",
      },
      cols: {
        type: "number",
        description: "terminal columns (40-400).",
      },
      rows: {
        type: "number",
        description: "terminal rows (10-200).",
      },
    },
    required: ["session_id", "cols", "rows"],
    additionalProperties: false,
  },
  run: (input) => {
    const session = getBackgroundBashSession(input.session_id);
    if (!session) {
      return invalidInput("resize_background_bash requires a valid `session_id`.");
    }
    if (session.transport !== "pty" || !session.pty) {
      return {
        ok: false,
        output: {
          status: "unsupported",
          session_id: session.id,
          transport: session.transport,
          full_terminal: session.fullTerminal,
          terminal_cols: null,
          terminal_rows: null,
        },
        error: "resize_background_bash requires a PTY full_terminal session",
      };
    }

    const cols = parseTerminalDimension(input.cols, session.terminalCols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS);
    const rows = parseTerminalDimension(input.rows, session.terminalRows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS);
    session.pty.resize(cols, rows);
    session.terminalCols = cols;
    session.terminalRows = rows;
    session.updatedAt = new Date().toISOString();

    return {
      ok: true,
      output: {
        status: "ok",
        session_id: session.id,
        transport: session.transport,
        full_terminal: session.fullTerminal,
        terminal_cols: session.terminalCols,
        terminal_rows: session.terminalRows,
      },
    };
  },
};

const listBackgroundBashTool: ToolDefinition<ListBackgroundBashInput> = {
  name: "list_background_bash",
  description: "list known background bash sessions and their state.",
  inputSchema: {
    type: "object",
    properties: {
      include_exited: {
        type: "boolean",
        description: "include exited sessions. default false.",
      },
    },
    additionalProperties: false,
  },
  run: (input) => {
    const includeExited = asBoolean(input.include_exited);
    const sessions = listBackgroundBashSessionSnapshots({
      include_exited: includeExited,
    });
    return {
      ok: true,
      output: {
        status: "ok",
        count: sessions.length,
        sessions,
      },
    };
  },
};

export const BASH_BUILTIN_TOOLS: ToolDefinition[] = [
  bashTool,
  readBackgroundBashTool,
  writeBackgroundBashTool,
  resizeBackgroundBashTool,
  stopBackgroundBashTool,
  listBackgroundBashTool,
];

function createDefaultSessionState(): { cwd: string; env: NodeJS.ProcessEnv } {
  return {
    cwd: process.cwd(),
    env: { ...process.env },
  };
}

export function listBackgroundBashSessionSnapshots(params?: {
  include_exited?: boolean;
}): BackgroundBashSessionSnapshot[] {
  const includeExited = params?.include_exited === true;
  return Array.from(backgroundBashSessions.values())
    .filter((session) => includeExited || session.status === "running")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map((session) => ({
      session_id: session.id,
      session_name: session.name,
      running: session.status === "running",
      status: session.status,
      shell: session.shell,
      command: session.commandText,
      cwd: session.cwd,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      unread_stdout_chars: unreadBackgroundChars(session.stdout),
      unread_stderr_chars: unreadBackgroundChars(session.stderr),
      transport: session.transport,
      full_terminal: session.fullTerminal,
      terminal_cols: session.terminalCols,
      terminal_rows: session.terminalRows,
    }));
}

function createBackgroundBashSessionId(): string {
  const suffix = Math.random().toString(16).slice(2, 10);
  return `bg-bash-${Date.now()}-${suffix}`;
}

function findRunningBackgroundBashSession(name: string, cwd: string, fullTerminal: boolean): BackgroundBashSession | null {
  for (const session of backgroundBashSessions.values()) {
    if (session.status !== "running") {
      continue;
    }
    if (session.name === name && session.cwd === cwd && session.fullTerminal === fullTerminal) {
      return session;
    }
  }
  return null;
}

function ensureBackgroundBashCleanupHook(): void {
  if (backgroundBashCleanupInstalled) {
    return;
  }
  backgroundBashCleanupInstalled = true;
  process.on("exit", () => {
    for (const session of backgroundBashSessions.values()) {
      if (session.status !== "running") {
        continue;
      }
      try {
        if (session.transport === "pty") {
          session.pty?.kill();
        } else {
          session.child?.kill("SIGTERM");
        }
      } catch {
        // best effort cleanup
      }
    }
  });
}

function createBackgroundStreamState(): BackgroundStreamState {
  return {
    buffer: "",
    totalChars: 0,
    droppedChars: 0,
    readCursor: 0,
  };
}

function appendToBackgroundStream(stream: BackgroundStreamState, chunk: string): void {
  if (!chunk) {
    return;
  }
  stream.totalChars += chunk.length;
  stream.buffer = `${stream.buffer}${chunk}`;
  if (stream.buffer.length > MAX_BACKGROUND_CAPTURE_CHARS) {
    const dropCount = stream.buffer.length - MAX_BACKGROUND_CAPTURE_CHARS;
    stream.buffer = stream.buffer.slice(dropCount);
    stream.droppedChars += dropCount;
  }
}

function sanitizeTerminalOutput(value: string): string {
  if (!value) {
    return "";
  }

  let text = value.replace(/\r\n/g, "\n");

  // Strip OSC sequences (title changes, hyperlinks) ending with BEL or ST.
  text = text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "");
  // Strip CSI sequences.
  text = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  // Strip remaining single-character escape sequences.
  text = text.replace(/\u001b[@-Z\\-_]/g, "");
  // Strip remaining non-printable control characters except tab/newline.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  // Some terminals leak repeated focus-in/out markers as literal "[I"/"[O".
  text = text.replace(/(?:\[(?:I|O)){3,}/g, "");

  return text;
}

function normalizeBackgroundStreamSelector(value: JsonValue | undefined): BackgroundStreamSelector | null {
  if (value === undefined) {
    return "both";
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "both" || normalized === "stdout" || normalized === "stderr") {
    return normalized;
  }
  return null;
}

function parseBackgroundReadChars(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_BACKGROUND_READ_CHARS;
  }
  return Math.max(1, Math.min(MAX_BACKGROUND_READ_CHARS, Math.floor(value)));
}

function parseTerminalDimension(
  value: JsonValue | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseRepeatCount(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function resolveSpecialKeySequence(keyName: string): string | null {
  const normalized = keyName.trim().toLowerCase();
  return SPECIAL_KEY_SEQUENCES[normalized] ?? null;
}

function getBackgroundBashSession(value: JsonValue | undefined): BackgroundBashSession | null {
  const sessionId = asNonEmptyString(value);
  if (!sessionId) {
    return null;
  }
  return backgroundBashSessions.get(sessionId) ?? null;
}

async function writeToBackgroundSession(
  session: BackgroundBashSession,
  payload: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (session.transport === "pty") {
    if (!session.pty) {
      return {
        ok: false,
        error: "background PTY session is unavailable",
      };
    }
    try {
      session.pty.write(payload);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: `failed writing to PTY session: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!session.child?.stdin || session.child.stdin.destroyed) {
    return {
      ok: false,
      error: "background bash session stdin is unavailable",
    };
  }
  try {
    await writeToBackgroundStdin(session.child.stdin, payload);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `failed writing to background stdin: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function unreadBackgroundChars(stream: BackgroundStreamState): number {
  const cursor = Math.max(stream.readCursor, stream.droppedChars);
  return Math.max(0, stream.totalChars - cursor);
}

function createEmptyBackgroundRead(cursor: number): {
  text: string;
  cursor: number;
  hasMore: boolean;
  dropped: boolean;
} {
  return {
    text: "",
    cursor,
    hasMore: false,
    dropped: false,
  };
}

function readBackgroundStream(
  stream: BackgroundStreamState,
  maxChars: number,
  peek: boolean,
): {
  text: string;
  cursor: number;
  hasMore: boolean;
  dropped: boolean;
} {
  const dropped = stream.readCursor < stream.droppedChars;
  const startCursor = Math.max(stream.readCursor, stream.droppedChars);
  const availableChars = Math.max(0, stream.totalChars - startCursor);
  const readChars = Math.min(maxChars, availableChars);
  const startIndex = startCursor - stream.droppedChars;
  const text = readChars > 0 ? stream.buffer.slice(startIndex, startIndex + readChars) : "";
  const nextCursor = startCursor + text.length;
  const hasMore = stream.totalChars > nextCursor;

  if (!peek) {
    stream.readCursor = nextCursor;
  }

  return {
    text,
    cursor: nextCursor,
    hasMore,
    dropped,
  };
}

async function resolveShellRuntime(): Promise<ResolvedShell | null> {
  if (process.platform === "win32") {
    const comSpec = process.env.ComSpec || "cmd.exe";
    const powerShellCandidates = dedupeStrings([
      process.env.POWERSHELL_EXE || "",
      comSpec.toLowerCase().includes("powershell") ? comSpec : "",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "powershell",
      "pwsh",
    ]);

    const candidates: ResolvedShell[] = [
      ...powerShellCandidates.map((command) => ({
        shell: "powershell" as const,
        command,
        argsForCommand: (wrappedCommand: string) => ["-NoLogo", "-Command", wrappedCommand],
        wrapCommand: wrapPowerShellCommand,
      })),
      {
        shell: "cmd",
        command: comSpec,
        argsForCommand: (wrappedCommand) => ["/Q", "/D", "/C", wrappedCommand],
        wrapCommand: wrapCmdCommand,
      },
    ];

    for (const candidate of candidates) {
      if (await hasRunnableShell(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  const unixCandidates: ResolvedShell[] = [
    {
      shell: "zsh",
      command: "zsh",
      argsForCommand: (wrappedCommand) => ["-lc", wrappedCommand],
      wrapCommand: wrapPosixCommand,
    },
    {
      shell: "bash",
      command: "bash",
      argsForCommand: (wrappedCommand) => ["-lc", wrappedCommand],
      wrapCommand: wrapPosixCommand,
    },
    {
      shell: "sh",
      command: "sh",
      argsForCommand: (wrappedCommand) => ["-c", wrappedCommand],
      wrapCommand: wrapPosixCommand,
    },
  ];

  for (const candidate of unixCandidates) {
    if (await hasRunnableShell(candidate)) {
      return candidate;
    }
  }
  return null;
}

function wrapPosixCommand(command: string, markerPrefix: string): string {
  return [
    "set +e",
    command,
    "__loaf_status=$?",
    `printf '%s\\n' '${markerPrefix}CWD_START'`,
    "pwd",
    `printf '%s\\n' '${markerPrefix}CWD_END'`,
    `printf '%s\\n' '${markerPrefix}ENV_START'`,
    "env",
    `printf '%s\\n' '${markerPrefix}ENV_END'`,
    "exit $__loaf_status",
  ].join("\n");
}

function wrapPowerShellCommand(command: string, markerPrefix: string): string {
  return [
    "$ErrorActionPreference = 'Continue'",
    command,
    "$__loaf_status = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }",
    `Write-Output '${markerPrefix}CWD_START'`,
    "(Get-Location).Path",
    `Write-Output '${markerPrefix}CWD_END'`,
    `Write-Output '${markerPrefix}ENV_START'`,
    "Get-ChildItem Env: | ForEach-Object { \"$($_.Name)=$($_.Value)\" }",
    `Write-Output '${markerPrefix}ENV_END'`,
    "exit $__loaf_status",
  ].join("\n");
}

function wrapCmdCommand(command: string, markerPrefix: string): string {
  return [
    "@echo off",
    command,
    "set __LOAF_STATUS=%ERRORLEVEL%",
    `echo ${markerPrefix}CWD_START`,
    "cd",
    `echo ${markerPrefix}CWD_END`,
    `echo ${markerPrefix}ENV_START`,
    "set",
    `echo ${markerPrefix}ENV_END`,
    "exit /b %__LOAF_STATUS%",
  ].join("\r\n");
}

function createMarkerPrefix(): string {
  const suffix = Math.random().toString(16).slice(2, 10);
  return `__LOAF_BASH_${Date.now()}_${suffix}__`;
}

function parseShellStateCapture(stdout: string, markerPrefix: string): ParsedStateCapture {
  const normalized = stdout.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const cwdStart = `${markerPrefix}CWD_START`;
  const cwdEnd = `${markerPrefix}CWD_END`;
  const envStart = `${markerPrefix}ENV_START`;
  const envEnd = `${markerPrefix}ENV_END`;

  const cwdStartIndex = lines.indexOf(cwdStart);
  const cwdEndIndex = lines.indexOf(cwdEnd, cwdStartIndex + 1);
  const envStartIndex = lines.indexOf(envStart, cwdEndIndex + 1);
  const envEndIndex = lines.indexOf(envEnd, envStartIndex + 1);

  if (
    cwdStartIndex < 0 ||
    cwdEndIndex < 0 ||
    envStartIndex < 0 ||
    envEndIndex < 0 ||
    !(cwdStartIndex < cwdEndIndex && cwdEndIndex < envStartIndex && envStartIndex < envEndIndex)
  ) {
    return {
      cleanedStdout: stdout,
      cwdAfter: null,
      envAfter: null,
      stateCaptured: false,
    };
  }

  const cwdAfter = lines.slice(cwdStartIndex + 1, cwdEndIndex).join("\n").trim();
  const envLines = lines.slice(envStartIndex + 1, envEndIndex);
  const envAfter = parseEnvironmentLines(envLines);

  const cleanedLines = [...lines.slice(0, cwdStartIndex), ...lines.slice(envEndIndex + 1)];
  const cleanedStdout = cleanedLines.join("\n").replace(/\n+$/g, "");

  return {
    cleanedStdout,
    cwdAfter: cwdAfter || null,
    envAfter,
    stateCaptured: true,
  };
}

function parseEnvironmentLines(lines: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of lines) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }
    env[key] = line.slice(separatorIndex + 1);
  }
  return env;
}

function parseTimeoutMs(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS * 1_000;
  }
  const seconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(value)));
  return seconds * 1_000;
}

function asNonEmptyString(value: JsonValue | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asBoolean(value: JsonValue | undefined): boolean {
  return value === true;
}

function buildPtyEnvironment(sourceEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    ...sourceEnv,
  };

  if (process.platform !== "win32") {
    return merged;
  }

  const pathValue =
    readFirstNonEmptyEnvValue(merged, ["Path", "PATH", "path"]) ||
    readFirstNonEmptyEnvValue(process.env, ["Path", "PATH", "path"]);
  if (pathValue) {
    merged.Path = pathValue;
    merged.PATH = pathValue;
  }

  const systemRoot =
    readFirstNonEmptyEnvValue(merged, ["SystemRoot", "SYSTEMROOT"]) ||
    readFirstNonEmptyEnvValue(process.env, ["SystemRoot", "SYSTEMROOT"]) ||
    "C:\\Windows";
  merged.SystemRoot = systemRoot;
  merged.SYSTEMROOT = systemRoot;

  const comSpec =
    readFirstNonEmptyEnvValue(merged, ["ComSpec", "COMSPEC"]) ||
    readFirstNonEmptyEnvValue(process.env, ["ComSpec", "COMSPEC"]) ||
    "C:\\Windows\\System32\\cmd.exe";
  merged.ComSpec = comSpec;
  merged.COMSPEC = comSpec;

  return merged;
}

function readFirstNonEmptyEnvValue(
  env: NodeJS.ProcessEnv,
  keys: string[],
): string {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function parseEnvOverrides(value: JsonValue | undefined): { ok: true; value: NodeJS.ProcessEnv } | { ok: false; error: string } {
  if (value === undefined) {
    return {
      ok: true,
      value: {},
    };
  }

  if (!isRecord(value)) {
    return {
      ok: false,
      error: "bash `env` must be an object mapping env var names to string values.",
    };
  }

  const parsed: NodeJS.ProcessEnv = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      return {
        ok: false,
        error: `bash \`env.${key}\` must be a string.`,
      };
    }
    parsed[key] = raw;
  }

  return {
    ok: true,
    value: parsed,
  };
}

async function writeToBackgroundStdin(stdin: NodeJS.WritableStream, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stdin.write(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): ToolResult {
  return {
    ok: false,
    output: {
      status: "invalid_input",
      message,
    },
    error: message,
  };
}

function summarizeProcessError(result: ProcessRunResult): string {
  const codeLabel = result.exitCode === null ? "no exit code" : `exit code ${result.exitCode}`;
  if (result.aborted) {
    return `process aborted (${codeLabel})`;
  }
  if (result.timedOut) {
    return `process timed out (${codeLabel})`;
  }
  return `process failed (${codeLabel})`;
}

async function hasRunnableShell(shell: ResolvedShell): Promise<boolean> {
  const cacheKey = `${shell.command}::${shell.shell}`;
  const cached = commandAvailabilityCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const probe = (async () => {
    const probeCommand = shell.wrapCommand("exit 0", "__LOAF_BASH_PROBE__");
    const result = await runCommand(shell.command, shell.argsForCommand(probeCommand), {
      timeoutMs: COMMAND_DETECTION_TIMEOUT_MS,
    });
    return result.exitCode !== null || result.signal !== null;
  })();

  commandAvailabilityCache.set(cacheKey, probe);
  return probe;
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ProcessRunResult> {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = typeof options.timeoutMs === "number" && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_SECONDS * 1_000;
  const startedAt = Date.now();

  let stdout = "";
  let stderr = "";
  let truncatedStdout = false;
  let truncatedStderr = false;
  let timedOut = false;
  let aborted = false;

  const child = spawnProcess(command, args, {
    cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const onStdout = (chunk: unknown) => {
    const next = `${stdout}${String(chunk)}`;
    if (next.length > MAX_CAPTURE_CHARS) {
      stdout = next.slice(0, MAX_CAPTURE_CHARS);
      truncatedStdout = true;
    } else {
      stdout = next;
    }
  };
  child.stdout?.on("data", onStdout);

  const onStderr = (chunk: unknown) => {
    const next = `${stderr}${String(chunk)}`;
    if (next.length > MAX_CAPTURE_CHARS) {
      stderr = next.slice(0, MAX_CAPTURE_CHARS);
      truncatedStderr = true;
    } else {
      stderr = next;
    }
  };
  child.stderr?.on("data", onStderr);

  const terminate = (signal: NodeJS.Signals): void => {
    try {
      child.kill(signal);
    } catch {
      // best effort
    }
  };

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    setTimeout(() => {
      terminate("SIGKILL");
    }, 1_500).unref();
  }, timeoutMs);

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    let settled = false;
    let sawExit = false;
    let sawClose = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settleAfterExitTimer: NodeJS.Timeout | null = null;
    let detachAbortListener: (() => void) | null = null;

    const finalize = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (settleAfterExitTimer) {
        clearTimeout(settleAfterExitTimer);
      }
      if (detachAbortListener) {
        detachAbortListener();
        detachAbortListener = null;
      }
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      resolve({
        exitCode,
        signal: exitSignal,
      });
    };

    const maybeFinalize = (): void => {
      if (!sawExit) {
        return;
      }
      if (sawClose) {
        finalize();
        return;
      }
      if (!settleAfterExitTimer) {
        settleAfterExitTimer = setTimeout(() => {
          finalize();
        }, 250);
        settleAfterExitTimer.unref();
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      sawExit = true;
      exitCode = code;
      exitSignal = signal;
      maybeFinalize();
    };

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      sawClose = true;
      if (!sawExit) {
        sawExit = true;
        exitCode = code;
        exitSignal = signal;
      }
      maybeFinalize();
    };

    const onError = (): void => {
      sawExit = true;
      sawClose = true;
      exitCode = null;
      exitSignal = null;
      maybeFinalize();
    };

    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("error", onError);

    if (options.signal) {
      const handleAbort = (): void => {
        aborted = true;
        terminate("SIGTERM");
        setTimeout(() => {
          terminate("SIGKILL");
        }, 1_500).unref();
      };

      if (options.signal.aborted) {
        handleAbort();
      } else {
        options.signal.addEventListener("abort", handleAbort, {
          once: true,
        });
        detachAbortListener = () => {
          options.signal?.removeEventListener("abort", handleAbort);
        };
      }
    }
  });

  clearTimeout(timeoutHandle);

  const durationMs = Date.now() - startedAt;
  return {
    command,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr,
    timedOut,
    aborted,
    durationMs,
    truncatedStdout,
    truncatedStderr,
    ok: !timedOut && !aborted && result.exitCode === 0,
  };
}
