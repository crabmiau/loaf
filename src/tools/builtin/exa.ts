import type { JsonValue, ToolDefinition, ToolInput, ToolResult } from "../types.js";

type SearchWebInput = ToolInput & {
  query?: JsonValue;
  type?: JsonValue;
  num_results?: JsonValue;
  include_text?: JsonValue;
  include_highlights?: JsonValue;
  highlight_query?: JsonValue;
  highlight_sentences?: JsonValue;
  highlights_per_url?: JsonValue;
  include_domains?: JsonValue;
  exclude_domains?: JsonValue;
};

type ExaToolOptions = {
  getApiKey: () => string;
};

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_DEFAULT_TYPE = "auto";
const EXA_DEFAULT_NUM_RESULTS = 8;
const EXA_MAX_NUM_RESULTS = 25;
const EXA_DEFAULT_HIGHLIGHT_SENTENCES = 2;
const EXA_DEFAULT_HIGHLIGHTS_PER_URL = 3;

export function createExaBuiltinTools(options: ExaToolOptions): ToolDefinition[] {
  const searchWebTool: ToolDefinition<SearchWebInput> = {
    name: "search_web",
    description:
      "search the web with exa and return answer-ready results with urls and highlights.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "search query text.",
        },
        type: {
          type: "string",
          description: "exa search mode: auto, fast, neural, or deep.",
        },
        num_results: {
          type: "number",
          description: "number of results to return (1-25, default 8).",
        },
        include_text: {
          type: "boolean",
          description: "include crawled text snippets in result rows when available.",
        },
        include_highlights: {
          type: "boolean",
          description: "include exa highlights (enabled by default).",
        },
        highlight_query: {
          type: "string",
          description: "optional query used specifically for highlight extraction.",
        },
        highlight_sentences: {
          type: "number",
          description: "sentences per highlight snippet (default 2).",
        },
        highlights_per_url: {
          type: "number",
          description: "how many highlight snippets per url (default 3).",
        },
        include_domains: {
          type: "array",
          description: "optional domain allowlist.",
          items: { type: "string" },
        },
        exclude_domains: {
          type: "array",
          description: "optional domain denylist.",
          items: { type: "string" },
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    run: async (input, context) => {
      const apiKey = options.getApiKey().trim();
      if (!apiKey) {
        const message =
          "search_web unavailable: missing exa api key. run /onboarding to set one.";
        return invalidInput(message);
      }

      const query = asNonEmptyString(input.query);
      if (!query) {
        return invalidInput("search_web requires a non-empty `query` string.");
      }

      const type = normalizeSearchType(input.type);
      const numResults = normalizeNumResults(input.num_results);
      const includeText = asBoolean(input.include_text);
      const includeHighlights = input.include_highlights === undefined ? true : asBoolean(input.include_highlights);
      const highlightQuery = asNonEmptyString(input.highlight_query) || query;
      const highlightSentences = normalizePositiveInt(input.highlight_sentences, EXA_DEFAULT_HIGHLIGHT_SENTENCES, 1, 8);
      const highlightsPerUrl = normalizePositiveInt(input.highlights_per_url, EXA_DEFAULT_HIGHLIGHTS_PER_URL, 1, 8);
      const includeDomains = parseStringArray(input.include_domains);
      const excludeDomains = parseStringArray(input.exclude_domains);

      const body: Record<string, unknown> = {
        query,
        type,
        numResults,
      };
      if (includeText || includeHighlights) {
        const contents: Record<string, unknown> = {};
        if (includeText) {
          contents.text = true;
        }
        if (includeHighlights) {
          contents.highlights = {
            query: highlightQuery,
            numSentences: highlightSentences,
            highlightsPerUrl,
          };
        }
        body.contents = contents;
      }
      if (includeHighlights) {
        body.highlights = {
          query: highlightQuery,
          numSentences: highlightSentences,
          highlightsPerUrl,
        };
      }
      if (includeDomains.length > 0) {
        body.includeDomains = includeDomains;
      }
      if (excludeDomains.length > 0) {
        body.excludeDomains = excludeDomains;
      }

      const response = await fetch(EXA_SEARCH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: context.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const message = `exa search failed (${response.status}): ${summarizeHttpError(text)}`;
        const output: Record<string, JsonValue> = {
          status: "error",
          query,
          type,
          num_results: numResults,
        };
        return {
          ok: false,
          output,
          error: message,
        };
      }

      const json = (await response.json()) as unknown;
      const payload = isRecord(json) ? json : {};
      const rows = Array.isArray(payload.results) ? payload.results : [];
      const normalizedRows = rows
        .map((row) => normalizeResultRow(row))
        .filter((row): row is Record<string, JsonValue> => row !== null)
        .slice(0, numResults);
      const requestId = asNonEmptyString(payload.requestId);
      const output: Record<string, JsonValue> = {
        status: "ok",
        query,
        type,
        num_results: numResults,
        total_results: normalizedRows.length,
        results: normalizedRows,
      };
      if (requestId) {
        output.request_id = requestId;
      }

      return {
        ok: true,
        output,
      };
    },
  };

  return [searchWebTool];
}

function normalizeSearchType(value: JsonValue | undefined): "auto" | "fast" | "neural" | "deep" {
  const normalized = asNonEmptyString(value).toLowerCase();
  if (normalized === "auto" || normalized === "fast" || normalized === "neural" || normalized === "deep") {
    return normalized;
  }
  return EXA_DEFAULT_TYPE;
}

function normalizeNumResults(value: JsonValue | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return EXA_DEFAULT_NUM_RESULTS;
  }
  const whole = Math.floor(value);
  return Math.max(1, Math.min(EXA_MAX_NUM_RESULTS, whole));
}

function normalizePositiveInt(
  value: JsonValue | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const whole = Math.floor(value);
  return Math.max(min, Math.min(max, whole));
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const cleaned = item.trim();
    if (!cleaned || rows.includes(cleaned)) {
      continue;
    }
    rows.push(cleaned);
  }
  return rows;
}

function normalizeResultRow(value: unknown): Record<string, JsonValue> | null {
  if (!isRecord(value)) {
    return null;
  }

  const url = asNonEmptyString(value.url);
  const title = asNonEmptyString(value.title);
  if (!url && !title) {
    return null;
  }

  const row: Record<string, JsonValue> = {
    title: title || url || "(untitled)",
    url: url || "",
  };
  const score = typeof value.score === "number" && Number.isFinite(value.score) ? value.score : undefined;
  const author = asNonEmptyString(value.author);
  const publishedDate = asNonEmptyString(value.publishedDate) || asNonEmptyString(value.published_date);
  const contents = isRecord(value.contents) ? value.contents : {};
  const text =
    asNonEmptyString(value.text) ||
    asNonEmptyString(value.content) ||
    asNonEmptyString(contents.text);
  const highlights = parseStringArray(value.highlights).length
    ? parseStringArray(value.highlights)
    : parseStringArray(contents.highlights);
  const highlightScores = parseNumberArray(value.highlight_scores).length
    ? parseNumberArray(value.highlight_scores)
    : parseNumberArray(contents.highlight_scores);
  if (typeof score === "number") {
    row.score = score;
  }
  if (author) {
    row.author = author;
  }
  if (publishedDate) {
    row.published_date = publishedDate;
  }
  if (text) {
    row.text = text.length <= 2_000 ? text : `${text.slice(0, 1_997)}...`;
  }
  if (highlights.length > 0) {
    row.highlights = highlights.map((item) => (item.length <= 400 ? item : `${item.slice(0, 397)}...`));
  }
  if (highlightScores.length > 0) {
    row.highlight_scores = highlightScores.slice(0, highlights.length || highlightScores.length);
  }
  return row;
}

function parseNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const rows: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      continue;
    }
    rows.push(item);
  }
  return rows;
}

function summarizeHttpError(payload: string): string {
  const text = payload.trim();
  if (!text) {
    return "empty response";
  }
  if (text.length <= 220) {
    return text;
  }
  return `${text.slice(0, 217)}...`;
}

function invalidInput(message: string): ToolResult {
  return {
    ok: false,
    output: {
      status: "invalid_input",
      message,
    },
    error: message,
  };
}

function asNonEmptyString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
