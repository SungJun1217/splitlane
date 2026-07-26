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
