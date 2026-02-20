export type ChatImageAttachment = {
  path: string;
  mimeType: string;
  dataUrl: string;
  byteSize: number;
};

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
  images?: ChatImageAttachment[];
};

export type ModelResult = {
  thoughts: string[];
  answer: string;
};

export type StreamChunk = {
  thoughts: string[];
  answerText: string;
};

export type DebugEvent = {
  stage: string;
  data: unknown;
};
