import fs from "node:fs/promises";
import path from "node:path";
import { getLoafDataDir } from "../../persistence.js";
import {
  installPipPackages,
  runInPython,
  runInPythonModule,
  type ProcessRunResult,
} from "../../python-runtime.js";
import type { JsonValue, ToolDefinition, ToolInput, ToolResult } from "../types.js";

type RunPyInput = ToolInput & {
  code?: JsonValue;
  args?: JsonValue;
  cwd?: JsonValue;
  timeout_seconds?: JsonValue;
  keep_script?: JsonValue;
};

type InstallPipInput = ToolInput & {
  packages?: JsonValue;
  args?: JsonValue;
  cwd?: JsonValue;
  timeout_seconds?: JsonValue;
  upgrade?: JsonValue;
};

type RunPyModuleInput = ToolInput & {
  module?: JsonValue;
  args?: JsonValue;
  cwd?: JsonValue;
  timeout_seconds?: JsonValue;
};

const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 60 * 20;

const runPyTool: ToolDefinition<RunPyInput> = {
  name: "run_py",
  description:
    "run arbitrary python code in loaf's venv and return stdout/stderr/exit details.",
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "the full python script to execute.",
      },
      args: {
        type: "array",
        description: "optional argv passed to the script.",
        items: { type: "string" },
      },
      cwd: {
        type: "string",
        description: "optional working directory for script execution.",
      },
      timeout_seconds: {
        type: "number",
        description: "optional timeout in seconds (default 120, max 1200).",
      },
      keep_script: {
        type: "boolean",
        description: "keep generated script file on disk for debugging. default false.",
      },
    },
    required: ["code"],
    additionalProperties: false,
  },
  run: async (input) => {
    const code = asNonEmptyString(input.code);
    if (!code) {
      return invalidInput("run_py requires a non-empty `code` string.");
    }

    const args = parseStringArray(input.args);
    const cwd = asNonEmptyString(input.cwd) || process.cwd();
    const timeoutMs = parseTimeoutMs(input.timeout_seconds);
    const keepScript = asBoolean(input.keep_script);

    const runDir = path.join(getLoafDataDir(), "python-runtime", "runs");
    await fs.mkdir(runDir, { recursive: true });
    const scriptPath = path.join(runDir, createScriptFileName());
    await fs.writeFile(scriptPath, code, "utf8");

    let result: ProcessRunResult;
    try {
      result = await runInPython([scriptPath, ...args], {
        cwd,
        timeoutMs,
      });
    } finally {
      if (!keepScript) {
        void fs.unlink(scriptPath).catch(() => {
          // best effort cleanup
        });
      }
    }

    return {
      ok: result.ok,
      output: processOutputToJson(result, {
        mode: "run_py",
        cwd,
        scriptPath,
      }),
      error: result.ok ? undefined : summarizeProcessError(result),
    };
  },
};

const installPipTool: ToolDefinition<InstallPipInput> = {
  name: "install_pip",
  description:
    "install python packages into loaf's venv using pip (supports upgrades and extra args).",
  inputSchema: {
    type: "object",
    properties: {
      packages: {
        type: "array",
        description: "package names to install, e.g. ['playwright', 'selenium'].",
        items: { type: "string" },
      },
      args: {
        type: "array",
        description: "extra pip args, e.g. ['--pre'] or ['-i', 'https://...'].",
        items: { type: "string" },
      },
      upgrade: {
        type: "boolean",
        description: "when true, adds --upgrade to pip install.",
      },
      cwd: {
        type: "string",
        description: "optional working directory.",
      },
      timeout_seconds: {
        type: "number",
        description: "optional timeout in seconds (default 120, max 1200).",
      },
    },
    required: ["packages"],
    additionalProperties: false,
  },
  run: async (input) => {
    const packages = parseStringArray(input.packages);
    if (packages.length === 0) {
      return invalidInput("install_pip requires at least one package name in `packages`.");
    }

    const extraArgs = parseStringArray(input.args);
    const cwd = asNonEmptyString(input.cwd) || process.cwd();
    const timeoutMs = parseTimeoutMs(input.timeout_seconds);
    const withUpgrade = asBoolean(input.upgrade);
    const finalArgs = withUpgrade ? ["--upgrade", ...extraArgs] : extraArgs;

    const result = await installPipPackages(packages, finalArgs, {
      cwd,
      timeoutMs,
    });

    return {
      ok: result.ok,
      output: processOutputToJson(result, {
        mode: "install_pip",
        cwd,
        packages,
      }),
      error: result.ok ? undefined : summarizeProcessError(result),
    };
  },
};

const runPyModuleTool: ToolDefinition<RunPyModuleInput> = {
  name: "run_py_module",
  description:
    "run python module entrypoints via `python -m <module> ...`, useful for tooling like playwright.",
  inputSchema: {
    type: "object",
    properties: {
      module: {
        type: "string",
        description: "module name, e.g. 'playwright' or 'pip'.",
      },
      args: {
        type: "array",
        description: "optional module args.",
        items: { type: "string" },
      },
      cwd: {
        type: "string",
        description: "optional working directory.",
      },
      timeout_seconds: {
        type: "number",
        description: "optional timeout in seconds (default 120, max 1200).",
      },
    },
    required: ["module"],
    additionalProperties: false,
  },
  run: async (input) => {
    const moduleName = asNonEmptyString(input.module);
    if (!moduleName) {
      return invalidInput("run_py_module requires a non-empty `module` string.");
    }

    const args = parseStringArray(input.args);
    const cwd = asNonEmptyString(input.cwd) || process.cwd();
    const timeoutMs = parseTimeoutMs(input.timeout_seconds);

    const result = await runInPythonModule(moduleName, args, {
      cwd,
      timeoutMs,
    });

    return {
      ok: result.ok,
      output: processOutputToJson(result, {
        mode: "run_py_module",
        cwd,
        module: moduleName,
      }),
      error: result.ok ? undefined : summarizeProcessError(result),
    };
  },
};

export const PYTHON_BUILTIN_TOOLS: ToolDefinition[] = [
  runPyTool,
  installPipTool,
  runPyModuleTool,
];

function parseTimeoutMs(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS * 1_000;
  }
  const seconds = Math.max(1, Math.min(MAX_TIMEOUT_SECONDS, Math.floor(value)));
  return seconds * 1_000;
}

function parseStringArray(value: JsonValue | undefined): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) {
          return parsed
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean);
        }
      } catch {
        // fall through
      }
    }
    return trimmed.split(/\s+/).filter(Boolean);
  }
  return [];
}

function createScriptFileName(): string {
  const suffix = Math.random().toString(16).slice(2, 10);
  return `run-${Date.now()}-${suffix}.py`;
}

function processOutputToJson(
  result: ProcessRunResult,
  details: Record<string, JsonValue>,
): ToolResult["output"] {
  return {
    status: result.ok ? "ok" : "error",
    ...details,
    command: result.command,
    args: result.args,
    exit_code: result.exitCode,
    signal: result.signal ?? null,
    timed_out: result.timedOut,
    duration_ms: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated_stdout: result.truncatedStdout,
    truncated_stderr: result.truncatedStderr,
  };
}

function summarizeProcessError(result: ProcessRunResult): string {
  const codeLabel = result.exitCode === null ? "no exit code" : `exit code ${result.exitCode}`;
  if (result.timedOut) {
    return `process timed out (${codeLabel})`;
  }
  return `process failed (${codeLabel})`;
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

function asNonEmptyString(value: JsonValue | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asBoolean(value: JsonValue | undefined): boolean {
  return value === true;
}
