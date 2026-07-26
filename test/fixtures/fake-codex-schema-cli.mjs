#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);

if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.145.0\n");
  process.exit(0);
}

if (args[0] === "app-server" && args[1] === "generate-json-schema" && args[2] === "--out" && args[3]) {
  const schema = {
    title: "ClientRequest",
    oneOf: [{
      properties: {
        method: { const: "review/start" },
        params: { $ref: "#/$defs/ReviewStartParams" },
      },
    }],
    $defs: {
      ReviewStartParams: { properties: { target: { $ref: "#/$defs/CustomReviewTarget" } } },
      CustomReviewTarget: { properties: { type: { const: "custom" } } },
      ReviewStartResponse: { properties: { reviewThreadId: { type: "string" } } },
    },
  };
  await writeFile(join(args[3], "ClientRequest.json"), JSON.stringify(schema));
  process.exit(0);
}

process.stderr.write(`unexpected fake Codex arguments: ${args.join(" ")}\n`);
process.exit(2);
