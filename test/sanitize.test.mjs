import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { parseClaudeAuth, parseCodexAuth, redactOpaqueIds, redactValue, sanitizeProviderIdentifier, sanitizeTerminalText } from "../spike/lib/sanitize.mjs";

test("sanitizes ANSI, OSC, and unsafe control sequences", () => {
  const input = "safe\x1b[31m red\x1b[0m\x1b]2;bad title\x07\x00 text\n";
  assert.equal(sanitizeTerminalText(input), "safe red text\n");
});

test("removes C1 and bidirectional spoofing controls", () => {
  assert.equal(sanitizeTerminalText("safe\u009b31m text\u202Ecodex"), "safe31m textcodex");
});

test("redacts sensitive fields and home paths recursively", () => {
  const value = redactValue({
    email: "person@example.com",
    codexHome: "/Users/example/.codex",
    nested: { accessToken: "top-secret", path: `${os.homedir()}/project` },
  });
  assert.equal(value.email, "<redacted>");
  assert.equal(value.codexHome, "<redacted>");
  assert.equal(value.nested.accessToken, "<redacted>");
  assert.equal(value.nested.path, "<home>/project");
});

test("authentication parsers retain only coarse status", () => {
  assert.deepEqual(
    parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: "oauth", apiProvider: "firstParty", email: "private@example.com", orgId: "secret" })),
    { loggedIn: true, authMethod: "oauth", apiProvider: "firstParty" },
  );
  assert.deepEqual(parseCodexAuth("Logged in using ChatGPT", 0), {
    loggedIn: true,
    authMethod: "chatgpt",
  });
});

test("opaque provider IDs are removed from diagnostic messages", () => {
  assert.equal(
    redactOpaqueIds("no rollout found for thread id 019f9ca3-d014-7833-9998-aa7ae9e1916c"),
    "no rollout found for thread id <opaque-id>",
  );
});

test("provider identifiers remove complete and truncated terminal styling", () => {
  assert.equal(sanitizeProviderIdentifier("\u001b[1mclaude-opus-5\u001b[0m"), "claude-opus-5");
  assert.equal(sanitizeProviderIdentifier("claude-opus-5[1m"), "claude-opus-5");
});
