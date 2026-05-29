import { Orchestrator } from "./orchestrator.js";
import { startMcpServer, startRestApi } from "./mcp/server.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  logger.info("fac-eu-brief starting…");

  const orchestrator = new Orchestrator();
  await orchestrator.init();

  // Run REST API always; MCP stdio only when not in a TTY (i.e. when invoked by an MCP client)
  await startRestApi(orchestrator);

  if (!process.stdin.isTTY) {
    await startMcpServer(orchestrator);
  } else {
    logger.info("Interactive terminal detected — MCP stdio server skipped. Use REST API on port " + process.env.API_PORT ?? "3101");
  }
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err.message, stack: err.stack });
  process.exit(1);
});
