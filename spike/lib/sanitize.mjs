import os from "node:os";

const SENSITIVE_KEY = /(?:token|secret|password|credential|email|org(?:id|name)?|accountid|api[_-]?key|codexhome)/i;

export function sanitizeTerminalText(value) {
  return String(value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function sanitizeProviderIdentifier(value) {
  return sanitizeTerminalText(value ?? "")
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trim();
}

export function redactOpaqueIds(value) {
  return String(value).replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "<opaque-id>",
  );
}

export function redactValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) {
    return "<redacted>";
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey),
      ]),
    );
  }

  if (typeof value === "string") {
    const home = os.homedir();
    return sanitizeTerminalText(home ? value.replaceAll(home, "<home>") : value);
  }

  return value;
}

export function parseClaudeAuth(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return {
      loggedIn: parsed.loggedIn === true,
      authMethod: typeof parsed.authMethod === "string" ? parsed.authMethod : "unknown",
      apiProvider: typeof parsed.apiProvider === "string" ? parsed.apiProvider : "unknown",
    };
  } catch {
    return { loggedIn: false, authMethod: "unknown", apiProvider: "unknown" };
  }
}

export function parseCodexAuth(stdout, exitCode) {
  const text = sanitizeTerminalText(stdout).toLowerCase();
  return {
    loggedIn: exitCode === 0 && text.includes("logged in"),
    authMethod: text.includes("chatgpt") ? "chatgpt" : text.includes("api key") ? "api-key" : "unknown",
  };
}
