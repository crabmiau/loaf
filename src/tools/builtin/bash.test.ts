import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BASH_BUILTIN_TOOLS } from "./bash.js";

const bashTool = getTool("bash");
const readBackgroundBashTool = getTool("read_background_bash");
const writeBackgroundBashTool = getTool("write_background_bash");
const resizeBackgroundBashTool = getTool("resize_background_bash");
const stopBackgroundBashTool = getTool("stop_background_bash");
const listBackgroundBashTool = getTool("list_background_bash");

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

  it("does not hang when command backgrounds a long-running process", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));
    if (shell === "cmd" || shell === "powershell") {
      return;
    }

    const startedAt = Date.now();
    const result = await runBash({
      command: shellBackgroundAndEcho(shell),
      timeout_seconds: 15,
    });
    const elapsedMs = Date.now() - startedAt;
    const output = asRecord(result.output);

    expect(result.ok).toBe(true);
    expect(readTrimmedString(output.stdout)).toContain("bg-started");
    expect(elapsedMs).toBeLessThan(10_000);
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

  it("can run bash in background and read completion output", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    const started = await runBash({
      command: shellBackgroundComplete(shell),
      run_in_background: true,
      session_name: "bash-bg-read-test",
    });
    expect(started.ok).toBe(true);
    const startedOutput = asRecord(started.output);
    const sessionId = readTrimmedString(startedOutput.session_id);
    expect(sessionId).toBeTruthy();

    await sleepMs(1300);
    const read = await readBackgroundBash(sessionId, {
      max_chars: 12000,
    });
    expect(read.ok).toBe(true);
    const readOutput = asRecord(read.output);
    expect(readTrimmedString(readOutput.stdout)).toContain("bg-finished");
  });

  it("lists and stops running background bash sessions", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    const started = await runBash({
      command: shellLongSleep(shell),
      run_in_background: true,
      session_name: "bash-bg-stop-test",
      reuse_session: false,
    });
    expect(started.ok).toBe(true);
    const startedOutput = asRecord(started.output);
    const sessionId = readTrimmedString(startedOutput.session_id);
    expect(sessionId).toBeTruthy();

    const listedBeforeStop = await listBackgroundBash();
    expect(listedBeforeStop.ok).toBe(true);
    const beforeRecord = asRecord(listedBeforeStop.output);
    const beforeSessions = Array.isArray(beforeRecord.sessions) ? beforeRecord.sessions : [];
    expect(
      beforeSessions.some(
        (entry) => isRecord(entry) && readTrimmedString(entry.session_id) === sessionId,
      ),
    ).toBe(true);

    const stopped = await stopBackgroundBash(sessionId, {
      force: true,
    });
    expect(stopped.ok).toBe(true);

    await sleepMs(300);
    const listedAfterStop = await listBackgroundBash({ include_exited: true });
    expect(listedAfterStop.ok).toBe(true);
    const afterRecord = asRecord(listedAfterStop.output);
    const afterSessions = Array.isArray(afterRecord.sessions) ? afterRecord.sessions : [];
    const sessionEntry = afterSessions.find(
      (entry) => isRecord(entry) && readTrimmedString(entry.session_id) === sessionId,
    );
    expect(sessionEntry && isRecord(sessionEntry) ? sessionEntry.running : undefined).toBe(false);
  });

  it("supports full terminal PTY input with key presses", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    const started = await runBash({
      command: shellInteractiveReadAndEcho(shell),
      run_in_background: true,
      full_terminal: true,
      reuse_session: false,
      session_name: "bash-bg-pty-input-test",
    });
    expect(started.ok).toBe(true);
    const startedOutput = asRecord(started.output);
    const sessionId = readTrimmedString(startedOutput.session_id);
    expect(sessionId).toBeTruthy();
    expect(startedOutput.transport).toBe("pty");

    const writeText = await writeBackgroundBash(sessionId, {
      input: "loaf-pty",
      append_newline: false,
    });
    expect(writeText.ok).toBe(true);
    const writeEnter = await writeBackgroundBash(sessionId, {
      key: "enter",
    });
    expect(writeEnter.ok).toBe(true);

    const stdout = await waitForBackgroundStdout(sessionId, "value:loaf-pty", 5_000);
    expect(stdout.toLowerCase()).toContain("value:loaf-pty");
  });

  it("resizes PTY sessions and rejects resize for pipe sessions", async () => {
    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    const ptyStarted = await runBash({
      command: shellLongSleep(shell),
      run_in_background: true,
      full_terminal: true,
      reuse_session: false,
      session_name: "bash-bg-pty-resize-test",
    });
    expect(ptyStarted.ok).toBe(true);
    const ptyStartedOutput = asRecord(ptyStarted.output);
    const ptySessionId = readTrimmedString(ptyStartedOutput.session_id);
    expect(ptySessionId).toBeTruthy();

    const resized = await resizeBackgroundBash(ptySessionId, {
      cols: 140,
      rows: 50,
    });
    expect(resized.ok).toBe(true);
    const resizedOutput = asRecord(resized.output);
    expect(resizedOutput.terminal_cols).toBe(140);
    expect(resizedOutput.terminal_rows).toBe(50);

    const pipeStarted = await runBash({
      command: shellLongSleep(shell),
      run_in_background: true,
      full_terminal: false,
      reuse_session: false,
      session_name: "bash-bg-pipe-resize-test",
    });
    expect(pipeStarted.ok).toBe(true);
    const pipeStartedOutput = asRecord(pipeStarted.output);
    const pipeSessionId = readTrimmedString(pipeStartedOutput.session_id);
    expect(pipeSessionId).toBeTruthy();

    const pipeResize = await resizeBackgroundBash(pipeSessionId, {
      cols: 100,
      rows: 30,
    });
    expect(pipeResize.ok).toBe(false);
    const pipeResizeOutput = asRecord(pipeResize.output);
    expect(pipeResizeOutput.status).toBe("unsupported");

    await stopBackgroundBash(ptySessionId, { force: true });
    await stopBackgroundBash(pipeSessionId, { force: true });
  });

  it("starts full terminal background sessions even when PATH is cleared on windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const first = await runBash({ command: shellEcho("detect-shell") });
    const shell = readShellName(asRecord(first.output));

    await runBash({ command: shellClearPath(shell) });

    const started = await runBash({
      command: shellEcho("pty-path-ok"),
      run_in_background: true,
      full_terminal: true,
      reuse_session: false,
      cwd: "C:/testdir",
      session_name: "bash-bg-pty-path-test",
    });
    expect(started.ok).toBe(true);
    const startedOutput = asRecord(started.output);
    expect(startedOutput.transport).toBe("pty");

    const sessionId = readTrimmedString(startedOutput.session_id);
    expect(sessionId).toBeTruthy();
    const stdout = await waitForBackgroundStdout(sessionId, "pty-path-ok", 5_000);
    expect(stdout.toLowerCase()).toContain("pty-path-ok");
  });
});

async function runBash(input: Record<string, unknown>) {
  return bashTool.run(input as never, { now: new Date() });
}

async function readBackgroundBash(sessionId: string, extra: Record<string, unknown> = {}) {
  return readBackgroundBashTool.run(
    {
      session_id: sessionId,
      ...extra,
    } as never,
    { now: new Date() },
  );
}

async function writeBackgroundBash(sessionId: string, extra: Record<string, unknown> = {}) {
  return writeBackgroundBashTool.run(
    {
      session_id: sessionId,
      ...extra,
    } as never,
    { now: new Date() },
  );
}

async function resizeBackgroundBash(sessionId: string, extra: Record<string, unknown> = {}) {
  return resizeBackgroundBashTool.run(
    {
      session_id: sessionId,
      ...extra,
    } as never,
    { now: new Date() },
  );
}

async function stopBackgroundBash(sessionId: string, extra: Record<string, unknown> = {}) {
  return stopBackgroundBashTool.run(
    {
      session_id: sessionId,
      ...extra,
    } as never,
    { now: new Date() },
  );
}

async function listBackgroundBash(input: Record<string, unknown> = {}) {
  return listBackgroundBashTool.run(input as never, { now: new Date() });
}

function getTool(name: string) {
  const tool = BASH_BUILTIN_TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`tool not found: ${name}`);
  }
  return tool;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object output");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

function shellBackgroundAndEcho(shell: ShellName): string {
  if (shell === "powershell") {
    return "Start-Job -ScriptBlock { Start-Sleep -Seconds 30 } | Out-Null; Write-Output bg-started";
  }
  if (shell === "cmd") {
    return "start /B ping -n 30 127.0.0.1 > nul & echo bg-started";
  }
  return "sleep 30 & echo bg-started";
}

function shellLargeOutput(shell: ShellName): string {
  if (shell === "powershell") {
    return "[Console]::Out.Write(('x' * 305000))";
  }
  return "yes x | head -c 305000";
}

function shellBackgroundComplete(shell: ShellName): string {
  if (shell === "powershell") {
    return "Start-Sleep -Seconds 1; Write-Output bg-finished";
  }
  if (shell === "cmd") {
    return "ping 127.0.0.1 -n 2 > nul & echo bg-finished";
  }
  return "sleep 1; echo bg-finished";
}

function shellLongSleep(shell: ShellName): string {
  if (shell === "powershell") {
    return "Start-Sleep -Seconds 30";
  }
  if (shell === "cmd") {
    return "ping 127.0.0.1 -n 31 > nul";
  }
  return "sleep 30";
}

function shellInteractiveReadAndEcho(shell: ShellName): string {
  if (shell === "powershell") {
    return "$v = Read-Host 'value'; Write-Output (\"value:\" + $v)";
  }
  if (shell === "cmd") {
    return "set /p V=value: & echo value:%V%";
  }
  return "read V; echo value:$V";
}

function shellClearPath(shell: ShellName): string {
  if (shell === "powershell") {
    return "$env:Path=''; Write-Output path-cleared";
  }
  if (shell === "cmd") {
    return "set PATH= & echo path-cleared";
  }
  return "PATH=''; export PATH; echo path-cleared";
}

async function waitForBackgroundStdout(
  sessionId: string,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const startedAt = Date.now();
  let collected = "";
  while (Date.now() - startedAt < timeoutMs) {
    const read = await readBackgroundBash(sessionId, { max_chars: 12000 });
    const output = asRecord(read.output);
    collected += readTrimmedString(output.stdout);
    if (collected.toLowerCase().includes(needle.toLowerCase())) {
      return collected;
    }
    await sleepMs(120);
  }
  return collected;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
