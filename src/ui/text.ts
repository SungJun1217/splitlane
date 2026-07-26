import stringWidth from "string-width";

export function removeLastGrapheme(value: string): string {
  if (!value) return value;
  const Segmenter = Intl.Segmenter;
  const segments = [...new Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
  const last = segments.at(-1);
  return last ? value.slice(0, last.index) : "";
}

export function tailLines(value: string, limit: number): string {
  const lines = value.split("\n");
  return lines.slice(-Math.max(1, limit)).join("\n");
}

export function truncateLine(value: string, maxWidth: number): string {
  if (stringWidth(value) <= maxWidth) return value;
  if (maxWidth <= 1) return "…".slice(0, maxWidth);
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value);
  let result = "";
  for (const { segment } of segments) {
    if (stringWidth(result + segment) > maxWidth - 1) break;
    result += segment;
  }
  return `${result}…`;
}

export function fitLines(value: string, maxWidth: number, maxLines: number): string {
  const lines = value.split("\n");
  const limit = Math.max(1, maxLines);
  const visible = lines.slice(0, limit).map((line) => truncateLine(line, Math.max(1, maxWidth)));
  if (lines.length > limit) visible[limit - 1] = truncateLine(`… +${lines.length - limit + 1} more`, Math.max(1, maxWidth));
  return visible.join("\n");
}

export function lineCount(value: string): number {
  return value ? value.split("\n").length : 0;
}

export function maxScrollOffset(value: string, height: number): number {
  return Math.max(0, lineCount(value) - Math.max(1, height));
}

export function scrollWindow(
  value: string,
  height: number,
  requestedOffset: number,
): { content: string; offset: number; maxOffset: number } {
  const lines = (value || "No output yet.").split("\n");
  const visible = Math.max(1, height);
  const maxOffset = Math.max(0, lines.length - visible);
  const offset = Math.max(0, Math.min(maxOffset, requestedOffset));
  const end = lines.length - offset;
  const start = Math.max(0, end - visible);
  return { content: lines.slice(start, end).join("\n"), offset, maxOffset };
}
