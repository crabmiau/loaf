import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BASH_BUILTIN_TOOLS } from "./bash.js";

const bashTool = getBashTool();

type ShellName = "zsh" | "bash" | "sh" | "powershell" | "cmd";

describe("bash built-in tool", () => {
  beforeEach(async () => {
    await runBash({
      command: "echo reset",
      reset_session: true,
    });
  });

  it("runs a command and returns process output", async () => {
    const result = await runBash({
      command: shellEcho("loaf-test"),
    });
    const output = asRecord(result.output);

    expect(result.ok).toBe(true);
    expect(readTrimmedString(output.stdout)).toContain("loaf-test");
    expect(typeof output.shell).toBe("string");
    expect(output.mode).toBe("bash");
  });

  it("persists cwd across calls", async () => {
    const first = await runBash({ command: shellPwd("zsh") });
    const firstOutput = asRecord(first.output);
    const shell = readShellName(firstOutput);
    const beforePwd = readTrimmedString(firstOutput.cwd_after);

    await runBash({ command: shellCdParent(shell) });
    const second = await runBash({ command: shellPwd(shell) });
    const secondOutput = asRecord(second.output);
    const afterPwd = readTrimmedString(secondOutput.cwd_after);

    expect(beforePwd).toBeTruthy();
    expect(afterPwd).toBe(path.dirname(beforePwd));
  });

  it("persists env changes across calls", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    await runBash({
      command: shellSetEnv(shell, "LOAF_BASH_TEST_VAR", "persisted-value"),
    });
    const check = await runBash({
      command: shellGetEnv(shell, "LOAF_BASH_TEST_VAR"),
    });
    const checkOutput = asRecord(check.output);
    const stdout = readTrimmedString(checkOutput.stdout);

    expect(stdout).toContain("persisted-value");
  });

  it("reset_session clears persisted state", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    await runBash({
      command: shellSetEnv(shell, "LOAF_BASH_TEST_VAR", "to-reset"),
    });
    await runBash({
      command: shellNoop(shell),
      reset_session: true,
    });
    const check = await runBash({
      command: shellCheckEnvDefined(shell, "LOAF_BASH_TEST_VAR"),
    });
    const checkOutput = asRecord(check.output);
    const stdout = readTrimmedString(checkOutput.stdout);

    expect(stdout).toContain("missing");
  });

  it("enforces timeout_seconds and reports timed_out", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    const result = await runBash({
      command: shellSleep(shell, 2),
      timeout_seconds: 1,
    });
    const output = asRecord(result.output);

    expect(result.ok).toBe(false);
    expect(output.timed_out).toBe(true);
  });

  it("truncates oversized stdout", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));
    if (shell === "cmd") {
      return;
    }

    const result = await runBash({
      command: shellLargeOutput(shell),
    });
    const output = asRecord(result.output);

    expect(result.ok).toBe(true);
    expect(output.truncated_stdout).toBe(true);
    expect(readTrimmedString(output.stdout).length).toBeGreaterThan(0);
  });
});

async function runBash(input: Record<string, unknown>) {
  return bashTool.run(input as never, { now: new Date() });
}

function getBashTool() {
  const tool = BASH_BUILTIN_TOOLS.find((entry) => entry.name === "bash");
  if (!tool) {
    throw new Error("bash tool not found");
  }
  return tool;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object output");
  }
  return value as Record<string, unknown>;
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readShellName(output: Record<string, unknown>): ShellName {
  const shell = readTrimmedString(output.shell) as ShellName;
  if (!shell) {
    throw new Error("missing shell in tool output");
  }
  return shell;
}

function shellNoop(shell: ShellName): string {
  if (shell === "powershell") {
    return "$null";
  }
  if (shell === "cmd") {
    return "echo.";
  }
  return "true";
}

function shellEcho(text: string): string {
  return `echo ${text}`;
}

function shellPwd(shell: ShellName): string {
  if (shell === "powershell") {
    return "(Get-Location).Path";
  }
  if (shell === "cmd") {
    return "cd";
  }
  return "pwd";
}

function shellCdParent(shell: ShellName): string {
  if (shell === "powershell") {
    return "Set-Location ..";
  }
  return "cd ..";
}

function shellSetEnv(shell: ShellName, key: string, value: string): string {
  if (shell === "powershell") {
    return `$env:${key}='${value}'`;
  }
  if (shell === "cmd") {
    return `set ${key}=${value}`;
  }
  return `export ${key}='${value}'`;
}

function shellGetEnv(shell: ShellName, key: string): string {
  if (shell === "powershell") {
    return `$env:${key}`;
  }
  if (shell === "cmd") {
    return `echo %${key}%`;
  }
  return `printf '%s' "$${key}"`;
}

function shellCheckEnvDefined(shell: ShellName, key: string): string {
  if (shell === "powershell") {
    return `if ($env:${key}) { 'defined' } else { 'missing' }`;
  }
  if (shell === "cmd") {
    return `if defined ${key} (echo defined) else (echo missing)`;
  }
  return `[ -n "$${key}" ] && echo defined || echo missing`;
}

function shellSleep(shell: ShellName, seconds: number): string {
  if (shell === "powershell") {
    return `Start-Sleep -Seconds ${seconds}`;
  }
  if (shell === "cmd") {
    return `ping 127.0.0.1 -n ${seconds + 2} > nul`;
  }
  return `sleep ${seconds}`;
}

function shellLargeOutput(shell: ShellName): string {
  if (shell === "powershell") {
    return "[Console]::Out.Write(('x' * 305000))";
  }
  return "yes x | head -c 305000";
}
