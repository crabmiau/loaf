import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatImageAttachment } from "../chat-types.js";

export const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export type RuntimeImageInput =
  | {
      path: string;
      mime_type?: string;
      data_url?: string;
    }
  | {
      data_url: string;
      path?: string;
      mime_type?: string;
    };

export function normalizeRuntimeImageInputs(value: unknown): RuntimeImageInput[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rows: RuntimeImageInput[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) {
      continue;
    }

    const pathValue = readTrimmedString(raw.path);
    const mimeType = readTrimmedString(raw.mime_type || raw.mimeType);
    const dataUrl = readTrimmedString(raw.data_url || raw.dataUrl);

    if (!pathValue && !dataUrl) {
      continue;
    }

    rows.push({
      path: pathValue,
      mime_type: mimeType || undefined,
      data_url: dataUrl || undefined,
    });
  }

  return rows;
}

export function loadRuntimeImageAttachments(images: RuntimeImageInput[]): {
  ok: true;
  images: ChatImageAttachment[];
} | {
  ok: false;
  error: string;
} {
  const attachments: ChatImageAttachment[] = [];

  for (const image of images) {
    if (image.data_url) {
      const parsed = loadImageAttachmentFromDataUrl(image.data_url, image.path, image.mime_type);
      if (!parsed.ok) {
        return parsed;
      }
      attachments.push(parsed.image);
      continue;
    }

    if (image.path) {
      const parsed = loadImageAttachmentFromPath(image.path);
      if (!parsed.ok) {
        return parsed;
      }
      attachments.push(parsed.image);
    }
  }

  return {
    ok: true,
    images: attachments,
  };
}

export function loadImageAttachmentFromPath(rawPath: string):
  | { ok: true; image: ChatImageAttachment }
  | { ok: false; error: string } {
  const resolvedPath = resolveImagePath(rawPath);
  if (!resolvedPath) {
    return { ok: false, error: "no file path provided" };
  }
  if (!fs.existsSync(resolvedPath)) {
    return { ok: false, error: `file not found: ${resolvedPath}` };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    return { ok: false, error: `unable to stat file: ${resolvedPath}` };
  }
  if (!stats.isFile()) {
    return { ok: false, error: `not a file: ${resolvedPath}` };
  }
  if (stats.size > MAX_IMAGE_FILE_BYTES) {
    return {
      ok: false,
      error: `image too large (${formatByteSize(stats.size)}). max is ${formatByteSize(MAX_IMAGE_FILE_BYTES)}`,
    };
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  const mimeType = IMAGE_MIME_BY_EXT[extension];
  if (!mimeType) {
    return {
      ok: false,
      error: `unsupported image type: ${extension || "(no extension)"}. supported: ${Object.keys(IMAGE_MIME_BY_EXT).join(", ")}`,
    };
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(resolvedPath);
  } catch {
    return { ok: false, error: `unable to read image file: ${resolvedPath}` };
  }

  return {
    ok: true,
    image: {
      path: resolvedPath,
      mimeType,
      dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}`,
      byteSize: stats.size,
    },
  };
}

export function loadImageAttachmentFromDataUrl(
  rawDataUrl: string,
  fallbackPath?: string,
  hintedMimeType?: string,
): { ok: true; image: ChatImageAttachment } | { ok: false; error: string } {
  const dataUrl = rawDataUrl.trim();
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    return {
      ok: false,
      error: "invalid image data_url. expected data:<mime>;base64,<payload>",
    };
  }

  const mimeType = (hintedMimeType?.trim() || match[1] || "").toLowerCase();
  const payload = (match[2] || "").trim();
  if (!mimeType || !payload) {
    return {
      ok: false,
      error: "invalid image data_url payload",
    };
  }

  if (!Object.values(IMAGE_MIME_BY_EXT).includes(mimeType)) {
    return {
      ok: false,
      error: `unsupported image mime type: ${mimeType}`,
    };
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(payload, "base64");
  } catch {
    return {
      ok: false,
      error: "invalid base64 image payload",
    };
  }

  if (bytes.length <= 0) {
    return {
      ok: false,
      error: "image payload is empty",
    };
  }

  if (bytes.length > MAX_IMAGE_FILE_BYTES) {
    return {
      ok: false,
      error: `image too large (${formatByteSize(bytes.length)}). max is ${formatByteSize(MAX_IMAGE_FILE_BYTES)}`,
    };
  }

  return {
    ok: true,
    image: {
      path: fallbackPath?.trim() || `rpc-image-${Date.now()}.png`,
      mimeType,
      dataUrl,
      byteSize: bytes.length,
    },
  };
}

function resolveImagePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return "";
  }

  let normalized = trimmed;
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (normalized.startsWith("file://")) {
    try {
      normalized = decodeURIComponent(normalized.slice("file://".length));
    } catch {
      normalized = normalized.slice("file://".length);
    }
  }
  if (normalized.startsWith("~/")) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }

  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return path.resolve(process.cwd(), normalized);
}

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 b";
  }
  if (bytes < 1024) {
    return `${Math.floor(bytes)} b`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(kb >= 100 ? 0 : kb >= 10 ? 1 : 2)} kb`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 100 ? 0 : mb >= 10 ? 1 : 2)} mb`;
}
