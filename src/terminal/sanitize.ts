export function sanitizeTerminalText(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function sanitizeIdentifier(value: unknown): string {
  return sanitizeTerminalText(value)
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trim();
}

export function appendBounded(current: string, delta: string, maxLength = 120_000): string {
  const combined = current + sanitizeTerminalText(delta);
  return combined.length <= maxLength ? combined : combined.slice(combined.length - maxLength);
}
