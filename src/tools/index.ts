// import { BROWSER_BUILTIN_TOOLS } from "./builtin/browser.js";
import { loafConfig } from "../config.js";
import { createExaBuiltinTools } from "./builtin/exa.js";
import { PYTHON_BUILTIN_TOOLS } from "./builtin/python.js";
import { createToolRegistry } from "./registry.js";
import { ToolRuntime } from "./runtime.js";

let configuredExaApiKey = loafConfig.exaApiKey;

export function configureBuiltinTools(config: { exaApiKey?: string }): void {
  configuredExaApiKey = (config.exaApiKey ?? "").trim();
}

const EXA_BUILTIN_TOOLS = createExaBuiltinTools({
  getApiKey: () => configuredExaApiKey || loafConfig.exaApiKey,
});

export const defaultToolRegistry = createToolRegistry()
  // .registerMany(BROWSER_BUILTIN_TOOLS)
  .registerMany(PYTHON_BUILTIN_TOOLS)
  .registerMany(EXA_BUILTIN_TOOLS);

export const defaultToolRuntime = new ToolRuntime(defaultToolRegistry);
