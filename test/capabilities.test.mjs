import assert from "node:assert/strict";
import test from "node:test";
import { detectClaudeCapabilities, detectCodexCapabilities } from "../spike/lib/capabilities.mjs";

const byId = (items, id) => items.find((item) => item.id === id);

test("Claude capabilities keep unproved approval callbacks blocked", () => {
  const help = [
    "--output-format stream-json",
    "--include-partial-messages",
    "--resume --session-id --model --effort",
    "--permission-mode plan",
    "--agents --forward-subagent-text",
  ].join("\n");
  const capabilities = detectClaudeCapabilities(help);
  assert.equal(byId(capabilities, "streaming").availability, "available");
  assert.equal(byId(capabilities, "read_only").availability, "available");
  assert.equal(byId(capabilities, "resume").availability, "blocked");
  assert.equal(byId(capabilities, "interactive_approval").availability, "blocked");
  assert.equal(byId(capabilities, "claude.subagent").stability, "preview");
  assert.equal(byId(capabilities, "claude.subagent").availability, "blocked");
});

test("Codex capabilities require both CLI and schema evidence", () => {
  const capabilities = detectCodexCapabilities({
    help: "app-server --model read-only",
    execHelp: "--output-schema",
    reviewHelp: "--uncommitted --base",
    appServerHelp: "generate-json-schema",
    schemaText: '"turn/start" "thread/resume" "turn/interrupt" requestApproval effort',
  });
  assert.equal(byId(capabilities, "streaming").availability, "available");
  assert.equal(byId(capabilities, "resume").availability, "blocked");
  assert.equal(byId(capabilities, "interactive_approval").availability, "blocked");
  assert.equal(byId(capabilities, "codex.review").availability, "available");

  const withoutSchema = detectCodexCapabilities({
    help: "app-server --model read-only",
    execHelp: "--output-schema",
    reviewHelp: "--uncommitted --base",
    appServerHelp: "generate-json-schema",
    schemaText: "",
  });
  assert.equal(byId(withoutSchema, "streaming").availability, "unavailable");
  assert.equal(byId(withoutSchema, "interrupt").availability, "unavailable");
});

test("every capability uses the complete runtime manifest shape", () => {
  const capabilities = detectClaudeCapabilities("");
  const required = [
    "id",
    "provider",
    "label",
    "stability",
    "availability",
    "transport",
    "requirements",
    "input_schema",
    "safety_effect",
    "session_effect",
    "conflicts",
  ];
  for (const capability of capabilities) {
    assert.deepEqual(Object.keys(capability), required);
  }
});

test("version-matched live evidence unlocks resume and approval capabilities", () => {
  const claude = detectClaudeCapabilities(
    "stream-json --include-partial-messages --resume --session-id",
    { resume: true, interactiveApproval: true },
  );
  assert.equal(byId(claude, "resume").availability, "available");
  assert.equal(byId(claude, "interactive_approval").availability, "available");
  assert.equal(byId(claude, "interactive_approval").transport, "official-agent-sdk");

  const codex = detectCodexCapabilities({
    help: "app-server --model read-only",
    execHelp: "",
    reviewHelp: "",
    appServerHelp: "generate-json-schema",
    schemaText: '"thread/resume" requestApproval',
    liveEvidence: { resume: true, interactiveApproval: true },
  });
  assert.equal(byId(codex, "resume").availability, "available");
  assert.equal(byId(codex, "interactive_approval").availability, "available");
});
