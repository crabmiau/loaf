import { buildNotification } from "./protocol.js";

export type RpcEventEnvelope<T extends string, P extends Record<string, unknown>> = {
  type: T;
  timestamp: string;
  payload: P;
};

export function buildEventNotification<T extends string, P extends Record<string, unknown>>(
  type: T,
  payload: P,
) {
  const envelope: RpcEventEnvelope<T, P> = {
    type,
    timestamp: new Date().toISOString(),
    payload,
  };

  return buildNotification("event", envelope);
}
