import { spawn } from "node:child_process";
import type { JsonValue, ToolDefinition, ToolInput, ToolResult } from "../types.js";

type BashInput = ToolInput & {
  command?: JsonValue;
  timeout_seconds?: JsonValue;
  cwd?: JsonValue;
  env?: JsonValue;
  reset_session?: JsonValue;
};

type ProcessRunResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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

const MAX_CAPTURE_CHARS = 300_000;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 60 * 20;
const COMMAND_DETECTION_TIMEOUT_MS = 8_000;
const commandAvailabilityCache = new Map<string, Promise<boolean>>();

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
    },
    required: ["command"],
    additionalProperties: false,
  },
  run: async (input) => {
    const commandText = asNonEmptyString(input.command);
    if (!commandText) {
      return invalidInput("bash requires a non-empty `command` string.");
    }

    const timeoutMs = parseTimeoutMs(input.timeout_seconds);
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

    const markerPrefix = createMarkerPrefix();
    const wrappedCommand = shell.wrapCommand(commandText, markerPrefix);
    const processResult = await runCommand(shell.command, shell.argsForCommand(wrappedCommand), {
      cwd: cwdBefore,
      env: envBefore,
      timeoutMs,
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

export const BASH_BUILTIN_TOOLS: ToolDefinition[] = [bashTool];

function createDefaultSessionState(): { cwd: string; env: NodeJS.ProcessEnv } {
  return {
    cwd: process.cwd(),
    env: { ...process.env },
  };
}

async function resolveShellRuntime(): Promise<ResolvedShell | null> {
  if (process.platform === "win32") {
    const powerShellCommand = (process.env.ComSpec || "cmd.exe").toLowerCase().includes("powershell")
      ? process.env.ComSpec || "powershell"
      : "powershell";
    const candidates: ResolvedShell[] = [
      {
        shell: "powershell",
        command: powerShellCommand,
        argsForCommand: (wrappedCommand) => ["-NoLogo", "-Command", wrappedCommand],
        wrapCommand: wrapPowerShellCommand,
      },
      {
        shell: "cmd",
        command: process.env.ComSpec || "cmd.exe",
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

  const child = spawn(command, args, {
    cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout?.on("data", (chunk) => {
    const next = `${stdout}${String(chunk)}`;
    if (next.length > MAX_CAPTURE_CHARS) {
      stdout = next.slice(0, MAX_CAPTURE_CHARS);
      truncatedStdout = true;
    } else {
      stdout = next;
    }
  });

  child.stderr?.on("data", (chunk) => {
    const next = `${stderr}${String(chunk)}`;
    if (next.length > MAX_CAPTURE_CHARS) {
      stderr = next.slice(0, MAX_CAPTURE_CHARS);
      truncatedStderr = true;
    } else {
      stderr = next;
    }
  });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 1_500).unref();
  }, timeoutMs);

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
      });
    });

    child.on("error", () => {
      resolve({
        exitCode: null,
        signal: null,
      });
    });
  });

  clearTimeout(timeoutHandle);

  const durationMs = Date.now() - startedAt;
  const ok = !timedOut && result.exitCode === 0;

  return {
    command,
    args,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout,
    stderr,
    timedOut,
    durationMs,
    truncatedStdout,
    truncatedStderr,
    ok,
  };
}
