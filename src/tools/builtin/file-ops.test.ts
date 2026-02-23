import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { FILE_OPS_BUILTIN_TOOLS } from "./file-ops.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const dir of tmpDirs.splice(0, tmpDirs.length)) {
    await fs.rm(dir, {
      recursive: true,
      force: true,
    });
  }
});

describe("file-ops built-in tools", () => {
  it("read_file returns numbered slice output", async () => {
    const dir = await createTempDir();
    const target = path.join(dir, "sample.txt");
    await fs.writeFile(target, "alpha\nbeta\ngamma\n", "utf8");

    const readFileTool = getTool("read_file");
    const result = await readFileTool.run(
      {
        file_path: target,
        offset: 2,
        limit: 2,
      } as never,
      { now: new Date() },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("L2: beta\nL3: gamma");
  });

  it("read_file indentation mode expands around anchor line", async () => {
    const dir = await createTempDir();
    const target = path.join(dir, "indent.ts");
    await fs.writeFile(
      target,
      [
        "fn outer() {",
        "    if cond {",
        "        inner();",
        "    }",
        "    tail();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const readFileTool = getTool("read_file");
    const result = await readFileTool.run(
      {
        file_path: target,
        mode: "indentation",
        limit: 10,
        indentation: {
          anchor_line: 3,
          max_levels: 1,
          include_siblings: false,
        },
      } as never,
      { now: new Date() },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toBe("L2:     if cond {\nL3:         inner();\nL4:     }");
  });

  it("list_dir paginates and includes truncation hint", async () => {
    const dir = await createTempDir();
    await fs.mkdir(path.join(dir, "a"));
    await fs.mkdir(path.join(dir, "b"));
    await fs.writeFile(path.join(dir, "a", "a_child.txt"), "a", "utf8");
    await fs.writeFile(path.join(dir, "b", "b_child.txt"), "b", "utf8");

    const listDirTool = getTool("list_dir");
    const result = await listDirTool.run(
      {
        dir_path: dir,
        offset: 1,
        limit: 2,
        depth: 2,
      } as never,
      { now: new Date() },
    );

    expect(result.ok).toBe(true);
    const output = String(result.output);
    expect(output).toContain(`Absolute path: ${dir}`);
    expect(output).toContain("a/");
    expect(output).toContain("  a_child.txt");
    expect(output).toContain("More than 2 entries found");
  });

  it("grep_files returns matching files via rg", async () => {
    if (!rgAvailable()) {
      return;
    }

    const dir = await createTempDir();
    await fs.writeFile(path.join(dir, "match_one.txt"), "alpha beta", "utf8");
    await fs.writeFile(path.join(dir, "match_two.txt"), "alpha gamma", "utf8");
    await fs.writeFile(path.join(dir, "other.txt"), "omega", "utf8");

    const grepFilesTool = getTool("grep_files");
    const result = await grepFilesTool.run(
      {
        pattern: "alpha",
        path: dir,
        limit: 10,
      } as never,
      { now: new Date() },
    );

    expect(result.ok).toBe(true);
    const output = String(result.output);
    expect(output).toContain("match_one.txt");
    expect(output).toContain("match_two.txt");
    expect(output).not.toContain("other.txt");
  });

  it("apply_patch updates an existing file", async () => {
    const dir = await createTempDir();
    const target = path.join(dir, "update.txt");
    await fs.writeFile(target, "foo\nbar\n", "utf8");

    const patch = [
      "*** Begin Patch",
      `*** Update File: ${target}`,
      "@@",
      " foo",
      "-bar",
      "+baz",
      "*** End Patch",
    ].join("\n");

    const applyPatchTool = getTool("apply_patch");
    const result = await applyPatchTool.run(
      { input: patch } as never,
      { now: new Date() },
    );

    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain("Success. Updated the following files:");
    expect(String(result.output)).toContain(`M ${target}`);
    const next = await fs.readFile(target, "utf8");
    expect(next).toBe("foo\nbaz\n");
  });

  it("apply_patch can add and delete files", async () => {
    const dir = await createTempDir();
    const added = path.join(dir, "new-file.txt");
    const removed = path.join(dir, "remove-me.txt");
    await fs.writeFile(removed, "bye\n", "utf8");

    const patch = [
      "*** Begin Patch",
      `*** Add File: ${added}`,
      "+hello",
      `*** Delete File: ${removed}`,
      "*** End Patch",
    ].join("\n");

    const applyPatchTool = getTool("apply_patch");
    const result = await applyPatchTool.run(
      { input: patch } as never,
      { now: new Date() },
    );

    expect(result.ok).toBe(true);
    expect(String(result.output)).toContain(`A ${added}`);
    expect(String(result.output)).toContain(`D ${removed}`);
    expect(await fs.readFile(added, "utf8")).toBe("hello\n");
    await expect(fs.stat(removed)).rejects.toThrow();
  });
});

function getTool(name: string) {
  const tool = FILE_OPS_BUILTIN_TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

function rgAvailable(): boolean {
  const check = spawnSync("rg", ["--version"], {
    stdio: "ignore",
  });
  return check.status === 0;
}

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "loaf-fileops-"));
  tmpDirs.push(dir);
  return dir;
}
