export type LayoutMode = "focused" | "stacked" | "columns";

export function selectLayout(columns: number): LayoutMode {
  if (columns < 100) return "focused";
  if (columns < 180) return "stacked";
  return "columns";
}

export function contentHeight(rows: number): number {
  return Math.max(5, rows - 8);
}

export function laneOutputHeight(
  columns: number,
  rows: number,
  inspectorVisible: boolean,
  hasError = false,
): number {
  const layout = selectLayout(columns);
  const available = contentHeight(rows);
  const laneHeight = layout === "focused"
    ? inspectorVisible ? Math.max(6, Math.floor(available * 0.65)) : available
    : layout === "stacked" ? Math.max(5, Math.floor(available / 2)) : available;
  return Math.max(2, laneHeight - 5 - (hasError ? 2 : 0));
}
