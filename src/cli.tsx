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
import { MirrorPublisher } from "./mirror/publisher.ts";
import packageJson from "../package.json";

const HELP = `Splitlane ${packageJson.version}

Usage:
  splitlane [project] [--mirror]
  splitlane doctor [project] [--json]
  splitlane update

Commands:
  doctor    Probe local CLI, auth, schema, sandbox, and transport compatibility
            without starting a provider thread or model turn.
  update    Check and install the latest verified standalone release now.

Options:
  --mirror   Publish a read-only snapshot mirror for the desktop app on a local
             socket. The mirror can never send commands.
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
  const mirror = argv.includes("--mirror");
  const positional = argv.filter((value) => value !== "--mirror");
  if (positional.length > 1 || positional[0]?.startsWith("-")) {
    console.error(positional[0]?.startsWith("-") ? `Unknown option: ${positional[0]}` : "Splitlane accepts at most one project path.");
    process.exitCode = 2;
    return;
  }
  const requestedRoot = resolve(positional[0] ?? process.cwd());
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
  // The desktop mirror is opt-in per session: without --mirror there is no
  // socket and no extra surface. It only ever publishes, so a failure to listen
  // is reported into the TUI rather than taking the session down.
  const publisher = mirror
    ? await MirrorPublisher.start({
      source: orchestrator,
      projectRoot,
      stateDirectory: config.stateDirectory,
      version: packageJson.version,
      onError: (message) => orchestrator.showNotice(message),
    }).catch((error: unknown) => {
      console.error(`Splitlane mirror could not start: ${(error as Error).message}`);
      return null;
    })
    : null;
  render(<App orchestrator={orchestrator} onBeforeExit={async () => {
    await Promise.allSettled([updater.close(), publisher?.close()]);
  }} />, { alternateScreen: true, exitOnCtrlC: false });
  if (publisher) orchestrator.showNotice("Read-only desktop mirror is published for this session. Run `bun run gui:dev` to attach; it can only observe.");
  void updater.start().then((result) => orchestrator.reportUpdate(result));
}
