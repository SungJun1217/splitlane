import React from "react";
import { resolve } from "node:path";
import { render } from "ink";
import { CompareOrchestrator } from "./core/orchestrator.ts";
import { ClaudeAdapter } from "./providers/claude.ts";
import { CodexAdapter } from "./providers/codex.ts";
import { App } from "./ui/app.tsx";
import { discoverProjectRoot, loadConfig, stateDirectory } from "./config/config.ts";
import { formatDoctor, runDoctor } from "./compat/doctor.ts";
import { StandaloneUpdater } from "./update/updater.ts";
import packageJson from "../package.json";

const HELP = `Splitlane ${packageJson.version}

Usage:
  splitlane [project]
  splitlane doctor [project] [--json]
  splitlane update

Commands:
  doctor    Probe local CLI, auth, schema, sandbox, and transport compatibility
            without starting a provider thread or model turn.
  update    Check and install the latest verified standalone release now.

Options:
  --json     Print doctor/v1 JSON (doctor only)
  --help     Show this help
  --version  Show the Splitlane version
`;

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (argv[0] === "doctor" || argv[0] === "--doctor") {
    const doctorArgs = argv.slice(1);
    const unknown = doctorArgs.find((value) => value.startsWith("-") && value !== "--json");
    const roots = doctorArgs.filter((value) => !value.startsWith("-"));
    if (unknown || roots.length > 1) {
      console.error(unknown ? `Unknown doctor option: ${unknown}` : "Doctor accepts at most one project path.");
      process.exitCode = 2;
      return;
    }
    const requestedRoot = resolve(roots[0] ?? process.cwd());
    const projectRoot = await discoverProjectRoot(requestedRoot);
    const report = await runDoctor({ projectRoot });
    process.stdout.write(doctorArgs.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatDoctor(report));
    if (report.status === "fail") process.exitCode = 1;
    return;
  }
  if (argv[0] === "update") {
    if (argv.length > 1) {
      console.error("Update does not accept additional arguments.");
      process.exitCode = 2;
      return;
    }
    const updater = new StandaloneUpdater({
      currentVersion: packageJson.version,
      executablePath: process.execPath,
      stateDirectory: stateDirectory(),
      mode: "auto",
    });
    const result = await updater.start(true);
    const output = `${result.message}\n`;
    if (result.outcome === "failed" || result.outcome === "unsupported") {
      process.stderr.write(output);
      process.exitCode = 1;
    } else process.stdout.write(output);
    return;
  }
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
  const updater = new StandaloneUpdater({
    currentVersion: packageJson.version,
    executablePath: process.execPath,
    stateDirectory: config.stateDirectory,
    mode: config.updates.mode,
  });
  render(<App orchestrator={orchestrator} onBeforeExit={() => updater.close()} />, { alternateScreen: true, exitOnCtrlC: false });
  void updater.start().then((result) => orchestrator.reportUpdate(result));
}
