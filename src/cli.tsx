import React from "react";
import { resolve } from "node:path";
import { render } from "ink";
import { CompareOrchestrator } from "./core/orchestrator.ts";
import { ClaudeAdapter } from "./providers/claude.ts";
import { CodexAdapter } from "./providers/codex.ts";
import { App } from "./ui/app.tsx";
import { discoverProjectRoot, loadConfig } from "./config/config.ts";

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const requestedRoot = resolve(argv[0] ?? process.cwd());
  const projectRoot = await discoverProjectRoot(requestedRoot);
  let config;
  try {
    config = await loadConfig(projectRoot);
  } catch (error) {
    console.error(`Splitlane configuration error: ${(error as Error).message}`);
    process.exitCode = 2;
    return;
  }
  const orchestrator = new CompareOrchestrator(projectRoot, {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
  }, config);
  await orchestrator.initialize();
  render(<App orchestrator={orchestrator} />, { alternateScreen: true, exitOnCtrlC: false });
}
