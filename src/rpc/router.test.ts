import { describe, expect, it, vi } from "vitest";
import { RpcRouter } from "./router.js";
import { JSON_RPC_ERROR, RpcMethodError } from "./protocol.js";
import type { LoafCoreRuntime } from "../core/runtime.js";

function buildRuntimeStub() {
  const runtime = {
    shutdown: vi.fn(async (reason?: string) => ({ accepted: true as const, reason })),
    getState: vi.fn(() => ({ ok: true })),
    createSession: vi.fn(() => ({ session_id: "s1", state: { id: "s1" } })),
    getSession: vi.fn(() => ({ id: "s1" })),
    sendSessionPrompt: vi.fn(async () => ({ session_id: "s1", turn_id: "t1", accepted: true, queued: false })),
    steerSession: vi.fn(() => ({ session_id: "s1", accepted: true })),
    interruptSession: vi.fn(() => ({ session_id: "s1", interrupted: true })),
    queueList: vi.fn(() => ({ session_id: "s1", queue: [] })),
    queueClear: vi.fn(() => ({ session_id: "s1", cleared_count: 0 })),
    executeCommand: vi.fn(async () => ({ handled: true })),
    authStatus: vi.fn(() => ({ enabled_providers: [] })),
    connectOpenAi: vi.fn(async () => ({ provider: "openai" })),
    connectAntigravity: vi.fn(async () => ({ provider: "antigravity" })),
    setOpenRouterKey: vi.fn(async () => ({ configured: true, model_count: 0, source: "fallback" })),
    setExaKey: vi.fn(async () => ({ configured: true, skipped: false })),
    onboardingStatus: vi.fn(() => ({ completed: false })),
    onboardingComplete: vi.fn(async () => ({ completed: true })),
    modelList: vi.fn(() => ({ models: [] })),
    modelSelect: vi.fn(async () => ({ selected_model: "m" })),
    listOpenRouterProvidersForModel: vi.fn(async () => ({ model_id: "m", providers: [] })),
    getLimits: vi.fn(async () => ({ openai: null, antigravity: null })),
    historyList: vi.fn(() => ({ sessions: [] })),
    historyGet: vi.fn(() => ({ id: "h1" })),
    historyClearSession: vi.fn(() => ({ session_id: "s1", cleared: true as const })),
    skillsList: vi.fn(() => ({ skills: [] })),
    toolsList: vi.fn(() => ({ tools: [] })),
    setDebug: vi.fn(() => ({ super_debug: true })),
  };

  return runtime as unknown as LoafCoreRuntime;
}

describe("rpc router", () => {
  it("dispatches known methods", async () => {
    const router = new RpcRouter(buildRuntimeStub());
    const result = await router.dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "system.ping",
      params: {},
    });

    expect((result as Record<string, unknown>).ok).toBe(true);
  });

  it("throws method not found for unknown methods", async () => {
    const router = new RpcRouter(buildRuntimeStub());

    await expect(
      router.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "nope.method",
        params: {},
      }),
    ).rejects.toMatchObject({
      code: JSON_RPC_ERROR.METHOD_NOT_FOUND,
    } satisfies Partial<RpcMethodError>);
  });

  it("validates required params", async () => {
    const router = new RpcRouter(buildRuntimeStub());

    await expect(
      router.dispatch({
        jsonrpc: "2.0",
        id: 1,
        method: "session.get",
        params: {},
      }),
    ).rejects.toMatchObject({
      code: JSON_RPC_ERROR.INVALID_PARAMS,
    } satisfies Partial<RpcMethodError>);
  });
});
