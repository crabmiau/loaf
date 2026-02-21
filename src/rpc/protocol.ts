export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

export const JSON_RPC_VERSION = "2.0" as const;

export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
} as const;

export class RpcMethodError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcMethodError";
    this.code = code;
    this.data = data;
  }
}

export function isRpcMethodError(value: unknown): value is RpcMethodError {
  return value instanceof RpcMethodError;
}

export function buildRpcMethodError(
  code: number,
  message: string,
  data?: unknown,
): RpcMethodError {
  return new RpcMethodError(code, message, data);
}

export function buildErrorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

export function buildResultResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

export function buildNotification(method: string, params?: unknown): JsonRpcNotification {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method,
    params,
  };
}

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (value.jsonrpc !== JSON_RPC_VERSION) {
    return false;
  }
  if (typeof value.method !== "string" || !value.method.trim()) {
    return false;
  }
  if (!("id" in value)) {
    return false;
  }
  const id = value.id;
  if (typeof id !== "string" && typeof id !== "number" && id !== null) {
    return false;
  }
  return true;
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (!isRecord(value)) {
    return false;
  }
  if (value.jsonrpc !== JSON_RPC_VERSION) {
    return false;
  }
  if (typeof value.method !== "string" || !value.method.trim()) {
    return false;
  }
  return !("id" in value);
}

export function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false; error: Error } {
  try {
    return {
      ok: true,
      value: JSON.parse(raw),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function assertObjectParams(params: unknown, method: string): Record<string, unknown> {
  if (!isRecord(params)) {
    throw buildRpcMethodError(
      JSON_RPC_ERROR.INVALID_PARAMS,
      `invalid params for ${method}: expected object`,
      { reason: "invalid_params" },
    );
  }
  return params;
}

export function assertString(value: unknown, field: string, method: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw buildRpcMethodError(
      JSON_RPC_ERROR.INVALID_PARAMS,
      `invalid params for ${method}: \`${field}\` must be a non-empty string`,
      { reason: "invalid_params", field },
    );
  }
  return value.trim();
}

export function assertOptionalString(value: unknown, field: string, method: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw buildRpcMethodError(
      JSON_RPC_ERROR.INVALID_PARAMS,
      `invalid params for ${method}: \`${field}\` must be a string`,
      { reason: "invalid_params", field },
    );
  }
  const normalized = value.trim();
  return normalized || undefined;
}

export function assertBoolean(value: unknown, field: string, method: string): boolean {
  if (typeof value !== "boolean") {
    throw buildRpcMethodError(
      JSON_RPC_ERROR.INVALID_PARAMS,
      `invalid params for ${method}: \`${field}\` must be a boolean`,
      { reason: "invalid_params", field },
    );
  }
  return value;
}

export function assertOptionalBoolean(value: unknown, field: string, method: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return assertBoolean(value, field, method);
}

export function assertOptionalNumber(value: unknown, field: string, method: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw buildRpcMethodError(
      JSON_RPC_ERROR.INVALID_PARAMS,
      `invalid params for ${method}: \`${field}\` must be a finite number`,
      { reason: "invalid_params", field },
    );
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
