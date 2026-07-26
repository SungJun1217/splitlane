import React from "react";
import { resolve } from "node:path";
import { render } from "ink";
import { CompareOrchestrator } from "./core/orchestrator.ts";
import { ClaudeAdapter } from "./providers/claude.ts";
import { CodexAdapter } from "./providers/codex.ts";
import { App } from "./ui/app.tsx";

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const projectRoot = resolve(argv[0] ?? process.cwd());
  const orchestrator = new CompareOrchestrator(projectRoot, {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
  });
  await orchestrator.initialize();
  render(<App orchestrator={orchestrator} />, { alternateScreen: true, exitOnCtrlC: false });
}
