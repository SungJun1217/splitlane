#!/usr/bin/env bun
import { run } from "../src/cli.tsx";

await run(process.argv.slice(2));
