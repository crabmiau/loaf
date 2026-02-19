import { ToolRegistry } from "./registry.js";
import type { ToolCall, ToolContext, ToolResult } from "./types.js";

export class ToolRuntime {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(call: ToolCall, context?: Partial<ToolContext>): Promise<ToolResult> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return {
        ok: false,
        output: {
          callId: call.id ?? null,
          tool: call.name,
          status: "not_found",
        },
        error: `unknown tool: ${call.name}`,
      };
    }

    const resolvedContext: ToolContext = {
      now: new Date(),
      ...context,
    };

    try {
      const result = await tool.run(call.input, resolvedContext);
      return result;
    } catch (error) {
      return {
        ok: false,
        output: {
          callId: call.id ?? null,
          tool: call.name,
          status: "error",
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
