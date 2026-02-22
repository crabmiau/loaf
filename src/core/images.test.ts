import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadImageAttachmentFromDataUrl,
  loadImageAttachmentFromPath,
  loadRuntimeImageAttachments,
  normalizeRuntimeImageInputs,
} from "./images.js";

const tempFiles: string[] = [];

afterEach(() => {
  for (const filePath of tempFiles.splice(0)) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("core image helpers", () => {
  it("normalizes runtime image input rows", () => {
    const rows = normalizeRuntimeImageInputs([
      { path: "a.png" },
      { data_url: "data:image/png;base64,AAAA" },
      { nope: true },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("loads attachments from data urls", () => {
    const result = loadImageAttachmentFromDataUrl("data:image/png;base64,aGVsbG8=", "demo.png");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.image.path).toBe("demo.png");
      expect(result.image.mimeType).toBe("image/png");
    }
  });

  it("loads attachments from local paths", () => {
    const filePath = path.join(os.tmpdir(), `loaf-rpc-img-${Date.now()}.png`);
    tempFiles.push(filePath);
    fs.writeFileSync(filePath, Buffer.from("png-test"));

    const result = loadImageAttachmentFromPath(filePath);
    expect(result.ok).toBe(true);
  });

  it("returns error for invalid path", () => {
    const result = loadImageAttachmentFromPath("/tmp/does-not-exist-abc.png");
    expect(result.ok).toBe(false);
  });

  it("loads mixed image attachment list", () => {
    const result = loadRuntimeImageAttachments([
      { data_url: "data:image/png;base64,aGVsbG8=" },
      { data_url: "data:image/jpeg;base64,aGVsbG8=" },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.images).toHaveLength(2);
    }
  });
});
