import { startTuiApp } from "./index.js";
import { startRpcStdioServer } from "./rpc/stdio-server.js";

const argv = process.argv.slice(2);

void main(argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[loaf] fatal: ${message}`);
  process.exitCode = 1;
});

async function main(args: string[]): Promise<void> {
  const first = (args[0] ?? "").trim().toLowerCase();

  if (!first) {
    await startTuiApp();
    return;
  }

  if (first === "rpc") {
    await startRpcStdioServer();
    return;
  }

  console.error(`unknown subcommand: ${args[0]}`);
  console.error("usage:");
  console.error("  loaf        # start tui");
  console.error("  loaf rpc    # start json-rpc stdio server");
  process.exitCode = 1;
}
