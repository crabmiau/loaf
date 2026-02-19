# tools infrastructure

this folder contains the tool system used by `loaf`.

## structure

- `types.ts`: shared tool contracts (`ToolDefinition`, `ToolCall`, `ToolResult`)
- `registry.ts`: registration + lookup (`ToolRegistry`)
- `runtime.ts`: execution wrapper (`ToolRuntime`)
- `builtin/python.ts`: python-first tools (`run_py`, `install_pip`, `run_py_module`)
- `index.ts`: default registry/runtime exports

## add a new tool

1. create a new file in `src/tools/builtin/` exporting a `ToolDefinition`.
2. add your tool to an exported list (or create a new list).
3. register it in `src/tools/index.ts` via `defaultToolRegistry.register(...)` or `registerMany(...)`.
4. run `npm run typecheck`.

## quick check in cli

run the app and use `/tools` to print all currently registered tools.
