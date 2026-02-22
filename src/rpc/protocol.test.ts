import { describe, expect, it } from "vitest";
import {
  JSON_RPC_ERROR,
  assertObjectParams,
  buildErrorResponse,
  buildResultResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  safeJsonParse,
} from "./protocol.js";

describe("rpc protocol", () => {
  it("validates json-rpc requests", () => {
    expect(
      isJsonRpcRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "system.ping",
        params: {},
      }),
    ).toBe(true);

    expect(
      isJsonRpcRequest({
        jsonrpc: "2.0",
        method: "system.ping",
      }),
    ).toBe(false);
  });

  it("validates json-rpc notifications", () => {
    expect(
      isJsonRpcNotification({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "session.status" },
      }),
    ).toBe(true);

    expect(
      isJsonRpcNotification({
        jsonrpc: "2.0",
        id: 1,
        method: "event",
      }),
    ).toBe(false);
  });

  it("parses json safely", () => {
    expect(safeJsonParse('{"ok":true}').ok).toBe(true);
    expect(safeJsonParse("nope").ok).toBe(false);
  });

  it("builds result and error responses", () => {
    expect(buildResultResponse(7, { ok: true })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });

    expect(buildErrorResponse(7, JSON_RPC_ERROR.INVALID_PARAMS, "bad", { reason: "invalid" })).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: JSON_RPC_ERROR.INVALID_PARAMS,
        message: "bad",
        data: { reason: "invalid" },
      },
    });
  });

  it("assertObjectParams throws on non-object", () => {
    expect(() => assertObjectParams([], "x")).toThrowError("invalid params");
    expect(assertObjectParams({ value: 1 }, "x")).toEqual({ value: 1 });
  });
});
