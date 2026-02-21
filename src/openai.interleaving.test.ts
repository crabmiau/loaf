import { describe, expect, it } from "vitest";
import type { StreamChunk } from "./chat-types.js";
import { __openAiInternals } from "./openai.js";

describe("computeUnstreamedAnswerDelta", () => {
  const { computeUnstreamedAnswerDelta } = __openAiInternals;

  it("returns full answer when nothing streamed", () => {
    expect(computeUnstreamedAnswerDelta("hello", "")).toBe("hello");
  });

  it("returns only missing suffix when stream already emitted a prefix", () => {
    expect(computeUnstreamedAnswerDelta("hello world", "hello")).toBe(" world");
  });

  it("returns empty string when stream already emitted the full answer", () => {
    expect(computeUnstreamedAnswerDelta("hello world", "hello world")).toBe("");
  });

  it("returns empty string for mismatched stream content to avoid duplicate spam", () => {
    expect(computeUnstreamedAnswerDelta("hello world", "other")).toBe("");
  });
});

describe("extractAnswerDeltaFromChunk", () => {
  const { extractAnswerDeltaFromChunk } = __openAiInternals;

  it("joins answer segments when segments are present", () => {
    const chunk: StreamChunk = {
      thoughts: [],
      answerText: "ignored",
      segments: [
        { kind: "thought", text: "hmm" },
        { kind: "answer", text: "hello " },
        { kind: "answer", text: "world" },
      ],
    };

    expect(extractAnswerDeltaFromChunk(chunk)).toBe("hello world");
  });

  it("falls back to answerText when no answer segment exists", () => {
    const chunk: StreamChunk = {
      thoughts: [],
      answerText: "hello",
      segments: [{ kind: "thought", text: "hmm" }],
    };

    expect(extractAnswerDeltaFromChunk(chunk)).toBe("hello");
  });
});

describe("selectActionableFunctionCalls", () => {
  const { selectActionableFunctionCalls } = __openAiInternals;

  it("drops duplicate calls and terminal failed calls", () => {
    const calls = selectActionableFunctionCalls([
      {
        type: "function_call",
        name: "bash",
        call_id: "call-1",
        arguments: "{\"command\":\"pwd\"}",
        status: "completed",
      },
      {
        type: "function_call",
        name: "bash",
        call_id: "call-1",
        arguments: "{\"command\":\"pwd\"}",
        status: "completed",
      },
      {
        type: "function_call",
        name: "bash",
        call_id: "call-2",
        arguments: "{\"command\":\"ls\"}",
        status: "in_progress",
      },
      {
        type: "function_call",
        name: "bash",
        call_id: "call-3",
        arguments: "{\"command\":\"whoami\"}",
        status: "failed",
      },
      {
        type: "message",
      },
    ]);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.call_id).toBe("call-1");
    expect(calls[1]?.call_id).toBe("call-2");
  });
});

describe("extractResponseText", () => {
  const { extractResponseText } = __openAiInternals;

  it("reads direct output_text", () => {
    expect(
      extractResponseText({
        output_text: "direct",
      }),
    ).toBe("direct");
  });

  it("reads message content across supported text shapes", () => {
    expect(
      extractResponseText({
        output: [
          {
            type: "message",
            content: [
              { type: "output_text", text: "first" },
              { type: "text", text: { value: "second" } },
              { type: "text", value: "third" },
            ],
          },
        ],
      }),
    ).toBe("first\n\nsecond\n\nthird");
  });
});

describe("buildFunctionCallFollowUpInput", () => {
  const { buildFunctionCallFollowUpInput } = __openAiInternals;

  it("preserves Codex-style order: output items first, then tool outputs", () => {
    const followUp = buildFunctionCallFollowUpInput({
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "first" },
            { type: "text", value: "second" },
          ],
        },
        {
          type: "function_call",
          name: "bash",
          call_id: "call-1",
          arguments: "{\"command\":\"pwd\"}",
          status: "completed",
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "after call text" }],
        },
      ],
      functionCalls: [
        {
          type: "function_call",
          call_id: "call-1",
          name: "bash",
          arguments: "{\"command\":\"pwd\"}",
        },
      ],
      functionOutputs: [
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "ok",
        },
      ],
    });

    expect(followUp).toEqual([
      {
        type: "message",
        role: "assistant",
        content: "first\n\nsecond",
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "bash",
        arguments: "{\"command\":\"pwd\"}",
      },
      {
        type: "message",
        role: "assistant",
        content: "after call text",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "ok",
      },
    ]);
  });

  it("appends unmatched tool replay pairs as a fallback", () => {
    const followUp = buildFunctionCallFollowUpInput({
      output: [],
      functionCalls: [
        {
          type: "function_call",
          call_id: "call-2",
          name: "bash",
          arguments: "{\"command\":\"ls\"}",
        },
      ],
      functionOutputs: [
        {
          type: "function_call_output",
          call_id: "call-2",
          output: "listing",
        },
      ],
    });

    expect(followUp).toEqual([
      {
        type: "function_call",
        call_id: "call-2",
        name: "bash",
        arguments: "{\"command\":\"ls\"}",
      },
      {
        type: "function_call_output",
        call_id: "call-2",
        output: "listing",
      },
    ]);
  });
});

describe("pickOutputItemsForFollowUp", () => {
  const { pickOutputItemsForFollowUp } = __openAiInternals;

  it("prefers stream output_item.done ordering when available", () => {
    const picked = pickOutputItemsForFollowUp(
      [
        {
          type: "message",
          content: [{ type: "output_text", text: "from-stream" }],
        },
      ],
      {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "from-final" }],
          },
        ],
      },
    );

    expect(picked).toEqual([
      {
        type: "message",
        content: [{ type: "output_text", text: "from-stream" }],
      },
    ]);
  });

  it("falls back to final response output when stream list is empty", () => {
    const picked = pickOutputItemsForFollowUp(
      [],
      {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "from-final" }],
          },
        ],
      },
    );

    expect(picked).toEqual([
      {
        type: "message",
        content: [{ type: "output_text", text: "from-final" }],
      },
    ]);
  });
});

describe("computeIncrementalInput", () => {
  const { computeIncrementalInput } = __openAiInternals;

  it("returns only the strict append delta when signatures match", () => {
    const userMessage = {
      type: "message",
      role: "user",
      content: "hello",
    };
    const assistantMessage = {
      type: "message",
      role: "assistant",
      content: "running tool",
    };
    const functionCall = {
      type: "function_call",
      call_id: "call-1",
      name: "bash",
      arguments: "{\"command\":\"pwd\"}",
    };
    const functionCallOutput = {
      type: "function_call_output",
      call_id: "call-1",
      output: "ok",
    };

    const delta = computeIncrementalInput({
      previousResponseId: "resp_1",
      requestSignature: "same",
      lastRequestSignature: "same",
      fullInput: [userMessage, assistantMessage, functionCall, functionCallOutput],
      lastRequestInput: [userMessage],
      lastResponseAddedInput: [assistantMessage, functionCall],
    });

    expect(delta).toEqual([functionCallOutput]);
  });

  it("returns null when the non-input signature changed", () => {
    const delta = computeIncrementalInput({
      previousResponseId: "resp_1",
      requestSignature: "next",
      lastRequestSignature: "prev",
      fullInput: [{ type: "message", role: "user", content: "hello" }],
      lastRequestInput: [{ type: "message", role: "user", content: "hello" }],
      lastResponseAddedInput: [],
    });

    expect(delta).toBeNull();
  });
});

describe("toFunctionCallOutputBody", () => {
  const { toFunctionCallOutputBody } = __openAiInternals;

  it("emits plain text and content-item payloads without wrapper objects", () => {
    expect(toFunctionCallOutputBody("ok")).toBe("ok");
    expect(toFunctionCallOutputBody(undefined, "tool failed")).toBe("tool failed");
    expect(toFunctionCallOutputBody({ value: 1 })).toBe("{\"value\":1}");
    expect(
      toFunctionCallOutputBody([
        {
          type: "input_text",
          text: "line",
        },
      ]),
    ).toEqual([
      {
        type: "input_text",
        text: "line",
      },
    ]);
  });
});
