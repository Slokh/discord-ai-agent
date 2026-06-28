import { AsyncLocalStorage } from "node:async_hooks";

export type TraceContext = {
  traceId?: string;
  requestId?: string;
  guildId?: string;
  channelId?: string;
  userId?: string;
  messageId?: string;
};

const storage = new AsyncLocalStorage<TraceContext>();

export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}

export function runWithTrace<T>(context: TraceContext, callback: () => T): T {
  const parent = currentTraceContext() ?? {};
  return storage.run(compactTraceContext({ ...parent, ...context }), callback);
}

function compactTraceContext(context: TraceContext): TraceContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value != null && value !== "")) as TraceContext;
}
