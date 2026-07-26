export type LayoutMode = "focused" | "stacked" | "columns";

export function selectLayout(columns: number): LayoutMode {
  if (columns < 100) return "focused";
  if (columns < 180) return "stacked";
  return "columns";
}

export function contentHeight(rows: number): number {
  return Math.max(5, rows - 8);
}
