import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getLoafDataDir } from "./persistence.js";

type PythonLauncher = {
  command: string;
  baseArgs: string[];
};

type InstallStrategy = {
  label: string;
  steps: Array<{
    command: string;
    args: string[];
    timeoutMs?: number;
  }>;
};

export type PythonRuntime = {
  launcherCommand: string;
  launcherArgs: string[];
  pythonExecutable: string;
  runtimeRoot: string;
  venvDir: string;
  installedByBootstrap: boolean;
  createdVenv: boolean;
};

export type ProcessRunResult = {
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

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

const MAX_CAPTURE_CHARS = 300_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 12 * 60 * 1_000;
const VENV_TIMEOUT_MS = 4 * 60 * 1_000;

let runtimePromise: Promise<PythonRuntime> | null = null;

export function ensurePythonRuntime(): Promise<PythonRuntime> {
  if (!runtimePromise) {
    runtimePromise = bootstrapPythonRuntime();
  }
  return runtimePromise;
}

export async function runInPython(
  args: string[],
  options: RunCommandOptions = {},
): Promise<ProcessRunResult> {
  const runtime = await ensurePythonRuntime();
  return runCommand(runtime.pythonExecutable, args, options);
}

export async function runInPythonModule(
  moduleName: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<ProcessRunResult> {
  return runInPython(["-m", moduleName, ...args], options);
}

export async function installPipPackages(
  packages: string[],
  extraArgs: string[] = [],
  options: RunCommandOptions = {},
): Promise<ProcessRunResult> {
  return runInPython(["-m", "pip", "install", ...extraArgs, ...packages], options);
}

async function bootstrapPythonRuntime(): Promise<PythonRuntime> {
  let launcher = await detectPythonLauncher();
  let installedByBootstrap = false;
  if (!launcher) {
    installedByBootstrap = await attemptPythonInstall();
    launcher = await detectPythonLauncher();
  }

  if (!launcher) {
    throw new Error(
      "python was not found and automatic install failed. install python 3 manually, then relaunch loaf.",
    );
  }

  const runtimeRoot = path.join(getLoafDataDir(), "python-runtime");
  const venvDir = path.join(runtimeRoot, "venv");
  const pythonExecutable = resolveVenvPythonPath(venvDir);

  let createdVenv = false;
  if (!fs.existsSync(pythonExecutable)) {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    const createVenv = await runCommand(
      launcher.command,
      [...launcher.baseArgs, "-m", "venv", venvDir],
      {
        timeoutMs: VENV_TIMEOUT_MS,
      },
    );
    if (!createVenv.ok) {
      throw new Error(
        `failed to create python venv at ${venvDir}\n${formatCommandFailure(createVenv)}`,
      );
    }
    createdVenv = true;
  }

  const pipCheck = await runCommand(pythonExecutable, ["-m", "pip", "--version"], {
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (!pipCheck.ok) {
    const ensurePip = await runCommand(pythonExecutable, ["-m", "ensurepip", "--upgrade"], {
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    if (!ensurePip.ok) {
      throw new Error(`python venv created but pip is unavailable\n${formatCommandFailure(ensurePip)}`);
    }
  }

  return {
    launcherCommand: launcher.command,
    launcherArgs: launcher.baseArgs,
    pythonExecutable,
    runtimeRoot,
    venvDir,
    installedByBootstrap,
    createdVenv,
  };
}

async function detectPythonLauncher(): Promise<PythonLauncher | null> {
  const candidates = getPythonLauncherCandidates();
  for (const candidate of candidates) {
    const result = await runCommand(candidate.command, [...candidate.baseArgs, "--version"], {
      timeoutMs: 20_000,
    });
    if (!result.ok) {
      continue;
    }
    const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (combined.includes("python")) {
      return candidate;
    }
  }
  return null;
}

async function attemptPythonInstall(): Promise<boolean> {
  const strategies = getPythonInstallStrategies();
  for (const strategy of strategies) {
    let strategyOk = true;
    for (const step of strategy.steps) {
      const result = await runCommand(step.command, step.args, {
        timeoutMs: step.timeoutMs ?? INSTALL_TIMEOUT_MS,
      });
      if (!result.ok) {
        strategyOk = false;
        break;
      }
    }
    if (strategyOk) {
      return true;
    }
  }
  return false;
}

function getPythonLauncherCandidates(): PythonLauncher[] {
  if (process.platform === "win32") {
    return [
      { command: "py", baseArgs: ["-3"] },
      { command: "python", baseArgs: [] },
      { command: "python3", baseArgs: [] },
    ];
  }
  return [
    { command: "python3", baseArgs: [] },
    { command: "python", baseArgs: [] },
  ];
}

function getPythonInstallStrategies(): InstallStrategy[] {
  if (process.platform === "win32") {
    return [
      {
        label: "winget-python-3-12",
        steps: [
          {
            command: "winget",
            args: [
              "install",
              "--exact",
              "--id",
              "Python.Python.3.12",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ],
          },
        ],
      },
      {
        label: "winget-python-3-11",
        steps: [
          {
            command: "winget",
            args: [
              "install",
              "--exact",
              "--id",
              "Python.Python.3.11",
              "--accept-package-agreements",
              "--accept-source-agreements",
            ],
          },
        ],
      },
      {
        label: "choco-python",
        steps: [
          {
            command: "choco",
            args: ["install", "-y", "python"],
          },
        ],
      },
    ];
  }

  if (process.platform === "darwin") {
    return [
      {
        label: "brew-python",
        steps: [
          {
            command: "brew",
            args: ["install", "python"],
          },
        ],
      },
    ];
  }

  return [
    {
      label: "apt-python",
      steps: [
        {
          command: "sudo",
          args: ["-n", "apt-get", "update"],
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
        {
          command: "sudo",
          args: ["-n", "apt-get", "install", "-y", "python3", "python3-venv"],
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      ],
    },
    {
      label: "apt-python-no-sudo",
      steps: [
        {
          command: "apt-get",
          args: ["update"],
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
        {
          command: "apt-get",
          args: ["install", "-y", "python3", "python3-venv"],
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      ],
    },
    {
      label: "dnf-python",
      steps: [
        {
          command: "sudo",
          args: ["-n", "dnf", "install", "-y", "python3"],
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      ],
    },
    {
      label: "pacman-python",
      steps: [
        {
          command: "sudo",
          args: ["-n", "pacman", "-Sy", "--noconfirm", "python"],
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      ],
    },
  ];
}

function resolveVenvPythonPath(venvDir: string): string {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

function formatCommandFailure(result: ProcessRunResult): string {
  const details = [
    `command: ${result.command} ${result.args.join(" ")}`.trim(),
    `exit: ${String(result.exitCode)}`,
    result.timedOut ? "timed out: true" : "timed out: false",
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return details;
}

async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<ProcessRunResult> {
  const startedAt = Date.now();

  return await new Promise<ProcessRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncatedStdout = false;
    let truncatedStderr = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let settled = false;
    let timedOut = false;

    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        truncatedStdout,
        truncatedStderr,
        ok: !timedOut && exitCode === 0,
      });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = appendCaptured(stdout, chunk, MAX_CAPTURE_CHARS);
      stdout = next.text;
      truncatedStdout = truncatedStdout || next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const next = appendCaptured(stderr, chunk, MAX_CAPTURE_CHARS);
      stderr = next.text;
      truncatedStderr = truncatedStderr || next.truncated;
    });

    child.on("error", (error) => {
      stderr = stderr
        ? `${stderr}\n${error.message}`
        : error.message;
      settle();
    });

    child.on("exit", (code, nextSignal) => {
      exitCode = code;
      signal = nextSignal;
    });

    child.on("close", () => {
      settle();
    });
  });
}

function appendCaptured(
  current: string,
  chunk: Buffer | string,
  limit: number,
): { text: string; truncated: boolean } {
  if (current.length >= limit) {
    return { text: current, truncated: true };
  }
  const incoming = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const available = limit - current.length;
  if (incoming.length <= available) {
    return { text: current + incoming, truncated: false };
  }
  return {
    text: current + incoming.slice(0, available),
    truncated: true,
  };
}
