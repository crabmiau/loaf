import readline from "node:readline";
import { LoafCoreRuntime, type RuntimeEvent } from "../core/runtime.js";
import { buildEventNotification } from "./events.js";
import {
  JSON_RPC_ERROR,
  buildErrorResponse,
  buildResultResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isRpcMethodError,
  safeJsonParse,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./protocol.js";
import { RpcRouter } from "./router.js";

export async function startRpcStdioServer(): Promise<void> {
  const runtime = await LoafCoreRuntime.create({ rpcMode: true });
  const router = new RpcRouter(runtime);

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let shuttingDown = false;

  const unsubscribe = runtime.onEvent((event) => {
    const payload = eventToNotification(event);
    writeJsonLine(payload);
  });

  const onRequest = async (request: JsonRpcRequest) => {
    try {
      const result = await router.dispatch(request);
      writeJsonLine(buildResultResponse(request.id, result));
      if (request.method === "system.shutdown") {
        shuttingDown = true;
      }
    } catch (error) {
      const response = buildRpcErrorResponse(request.id, error);
      writeJsonLine(response);
    }
  };

  rl.on("line", (line) => {
    if (shuttingDown) {
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const parsed = safeJsonParse(trimmed);
    if (!parsed.ok) {
      writeJsonLine(
        buildErrorResponse(
          null,
          JSON_RPC_ERROR.PARSE_ERROR,
          `parse error: ${parsed.error.message}`,
          {
            reason: "parse_error",
          },
        ),
      );
      return;
    }

    const payload = parsed.value;
    if (Array.isArray(payload)) {
      writeJsonLine(
        buildErrorResponse(
          null,
          JSON_RPC_ERROR.INVALID_REQUEST,
          "batch requests are not supported",
          {
            reason: "batch_not_supported",
          },
        ),
      );
      return;
    }

    if (isJsonRpcRequest(payload)) {
      void onRequest(payload);
      return;
    }

    if (isJsonRpcNotification(payload)) {
      return;
    }

    writeJsonLine(
      buildErrorResponse(
        null,
        JSON_RPC_ERROR.INVALID_REQUEST,
        "invalid request",
        {
          reason: "invalid_request",
        },
      ),
    );
  });

  await new Promise<void>((resolve) => {
    rl.once("close", () => {
      resolve();
    });

    process.once("SIGINT", () => {
      if (!shuttingDown) {
        shuttingDown = true;
        void runtime.shutdown("sigint");
      }
      rl.close();
    });

    process.once("SIGTERM", () => {
      if (!shuttingDown) {
        shuttingDown = true;
        void runtime.shutdown("sigterm");
      }
      rl.close();
    });
  });

  unsubscribe();
  if (!shuttingDown) {
    await runtime.shutdown("stdin_closed");
  }
}

function writeJsonLine(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function eventToNotification(event: RuntimeEvent) {
  return buildEventNotification(event.type, event.payload);
}

function buildRpcErrorResponse(id: JsonRpcId, error: unknown): JsonRpcResponse {
  if (isRpcMethodError(error)) {
    return buildErrorResponse(id, error.code, error.message, error.data);
  }

  const message = error instanceof Error ? error.message : String(error);
  return buildErrorResponse(
    id,
    JSON_RPC_ERROR.INTERNAL_ERROR,
    message,
    {
      reason: "internal_error",
    },
  );
}
