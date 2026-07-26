#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import readline from "node:readline";

const [provider, ...args] = process.argv.slice(2);

if (provider === "claude") {
  if (args[0] === "--version") process.stdout.write("2.1.220 (Claude Code)\n");
  else if (args[0] === "--help") process.stdout.write("--print --output-format stream-json --permission-mode plan --model\n");
  else if (args[0] === "auth" && args[1] === "status") process.stdout.write('{"loggedIn":true,"email":"must-not-leak@example.invalid","token":"must-not-leak"}\n');
  else process.exitCode = 2;
} else if (provider === "codex") {
  if (args[0] === "--version") process.stdout.write("codex-cli 0.145.0\n");
  else if (args[0] === "--help") process.stdout.write("app-server --sandbox read-only workspace-write --model\n");
  else if (args[0] === "login" && args[1] === "status") process.stdout.write("Logged in using ChatGPT as must-not-leak@example.invalid\n");
  else if (args[0] === "app-server" && args[1] === "--help") process.stdout.write("generate-json-schema --stdio\n");
  else if (args[0] === "app-server" && args[1] === "generate-json-schema" && args[2] === "--out" && args[3]) {
    await mkdir(args[3], { recursive: true });
    await writeFile(join(args[3], "ClientRequest.json"), JSON.stringify({
      methods: ["thread/start", "thread/resume", "turn/start", "turn/interrupt", "review/start"],
      $defs: {
        ReviewStartParams: {},
        CustomReviewTarget: {},
        ReviewStartResponse: { properties: { reviewThreadId: { type: "string" } } },
        SandboxPolicy: { enum: ["readOnly", "workspaceWrite"] },
      },
    }));
    await writeFile(join(args[3], "ServerRequest.json"), JSON.stringify({ methods: ["requestApproval"] }));
  } else if (args[0] === "app-server" && args[1] === "--stdio") {
    const lines = readline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        process.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "fake-doctor/1" } })}\n`);
      }
    });
  } else process.exitCode = 2;
} else {
  process.stderr.write("provider argument required\n");
  process.exitCode = 2;
}
