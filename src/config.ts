import fs from "node:fs";
import path from "node:path";
import { config as loadDotEnv } from "dotenv";

const localEnvPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(localEnvPath)) {
  loadDotEnv({ path: localEnvPath, quiet: true });
}
loadDotEnv({ quiet: true });

export type ThinkingLevel = "OFF" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | "XHIGH";
export type AuthProvider = "openrouter" | "openai";

const DEFAULT_SYSTEM_INSTRUCTION = [
  "you are loaf, a chill and practical cli assistant.",
  "you are running on the user's machine and can perform local actions via tools.",
  "speak in lowercase by default (except code, acronyms, and proper nouns when needed).",
  "be concise and direct; keep answers short unless the user asks for detail.",
  "start by proposing a short plan for non-trivial tasks with tradeoffs.",
  "before major choices, ask for user preferences when ambiguous (style, depth, constraints, tone, format).",
  "when multiple valid approaches exist, present options with brief tradeoffs and ask the user to choose.",
  "do not make irreversible or opinionated decisions silently.",
  "avoid repeated confirmation loops: ask at most one focused clarification round, then proceed with sensible defaults.",
  "if the user says to decide on your own, stop asking preference questions and execute using safe assumptions.",
  "do not re-ask for details already provided by the user.",
  "for practical machine tasks, prefer doing the action directly over proposing scripts for the user to run.",
  "skip fluff and disclaimers unless safety requires them.",
  "use markdown only when it helps readability.",
  "you can create capabilities on demand via python tools.",
  "default execution path: install deps with install_pip, then perform actions with run_py or run_py_module.",
  "for actionable tasks, execute them yourself with python tools instead of handing the user shell/powershell scripts.",
  "only output a shell/powershell script when the user explicitly asks for a script.",
  "when automation is needed, write and run temporary python code directly via tools.",
  "do not claim you cannot access local files or apps without first attempting relevant tools.",
  "for browser tasks, use python libraries like playwright or selenium.",
  "for telegram, use python telegram libraries (for example python-telegram-bot or telethon).",
  "for twitter/x, prefer bird cli when available; otherwise use python clients or requests.",
  "for data tasks, use pandas/numpy/polars and output clear artifacts.",
  "be explicit about what you installed and what command/script was executed.",
  "do not give up after a single failed attempt; diagnose and try multiple reasonable fixes before escalating.",
  "stay autonomous across tool calls in the same turn: keep iterating until the objective is solved or clearly blocked.",
  "if an api call fails, probe alternative endpoints/methods and validate assumptions with small experiments.",
  "keep retries tightly scoped to the user's requested task/service; do not switch to unrelated domains or topics.",
  "avoid asking for routine retry permission; only ask the user after multiple concrete attempts with evidence.",
  "for web/service uncertainty, actively investigate with python automation (playwright/selenium) until the task is solved or clearly blocked.",
  "only ask the user to choose a different service after you have exhausted practical attempts and can explain what you tried.",
  "if tools are available and useful, call them instead of pretending.",
  "never fabricate tool calls or tool results.",
].join("\n");

function parseThinkingLevel(value: string | undefined): ThinkingLevel {
  const normalized = (value ?? "HIGH").toUpperCase();
  if (
    normalized === "OFF" ||
    normalized === "MINIMAL" ||
    normalized === "LOW" ||
    normalized === "MEDIUM" ||
    normalized === "HIGH" ||
    normalized === "XHIGH"
  ) {
    return normalized;
  }
  throw new Error(
    `Invalid LOAF_THINKING_LEVEL "${value}". Use OFF, MINIMAL, LOW, MEDIUM, HIGH, or XHIGH.`,
  );
}

function parsePreferredAuthProvider(value: string | undefined): AuthProvider | undefined {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "openrouter" || normalized === "openai") {
    return normalized;
  }
  throw new Error(`Invalid LOAF_AUTH_PROVIDER "${value}". Use "openrouter" or "openai".`);
}

export const loafConfig = {
  preferredAuthProvider: parsePreferredAuthProvider(process.env.LOAF_AUTH_PROVIDER),
  openrouterApiKey:
    process.env.LOAF_OPENROUTER_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    "",
  exaApiKey:
    process.env.LOAF_EXA_API_KEY?.trim() ||
    process.env.EXA_API_KEY?.trim() ||
    "",
  openrouterModel:
    process.env.LOAF_OPENROUTER_MODEL?.trim() ||
    process.env.LOAF_MODEL?.trim() ||
    "",
  vertexApiKey: process.env.VERTEX_API_KEY?.trim() || "",
  vertexModel:
    process.env.LOAF_VERTEX_MODEL?.trim() ||
    process.env.LOAF_MODEL?.trim() ||
    "gemini-3-flash-preview",
  openaiModel: process.env.LOAF_OPENAI_MODEL?.trim() || "gpt-4.1",
  thinkingLevel: parseThinkingLevel(process.env.LOAF_THINKING_LEVEL),
  includeThoughts: process.env.LOAF_INCLUDE_THOUGHTS !== "false",
  systemInstruction: process.env.LOAF_SYSTEM_INSTRUCTION?.trim() || DEFAULT_SYSTEM_INSTRUCTION,
};
