export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ToolInput = Record<string, JsonValue>;

export type ToolContext = {
  now: Date;
  log?: (message: string) => void;
  signal?: AbortSignal;
};

export type ToolResult<TOutput extends JsonValue = JsonValue> = {
  ok: boolean;
  output: TOutput;
  error?: string;
};

export type ToolDefinition<
  TInput extends ToolInput = ToolInput,
  TOutput extends JsonValue = JsonValue,
> = {
  name: string;
  description: string;
  inputSchema?: {
    type: "object";
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
    additionalProperties?: boolean;
  };
  run: (input: TInput, context: ToolContext) => Promise<ToolResult<TOutput>> | ToolResult<TOutput>;
};

export type ToolCall<TInput extends ToolInput = ToolInput> = {
  id?: string;
  name: string;
  input: TInput;
};
