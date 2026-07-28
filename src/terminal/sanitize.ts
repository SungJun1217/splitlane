export function sanitizeTerminalText(value: unknown): string {
  return String(value ?? "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    // A bare carriage return rewrites the line already on screen, which is
    // enough to spoof a decision that was never made ("denied\r approved"), so
    // it must not survive into the snapshot. Turning it into a newline instead
    // would multiply lines: providers redraw progress meters with a bare CR, and
    // one spinner would evict every real line from the bounded lane buffer. A
    // separator keeps each frame visible on one line and erases nothing.
    .replace(/\r\n|\r+/g, (match) => match === "\r\n" ? "\n" : " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
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
