export type LayoutMode = "focused" | "stacked" | "columns";
export type ViewMode = "both" | "focused";

export function selectLayout(columns: number, viewMode: ViewMode = "both"): LayoutMode {
  if (viewMode === "focused") return "focused";
  if (columns < 180) return "stacked";
  return "columns";
}

export function headerHeight(columns: number): number {
  return columns < 100 ? 4 : 3;
}

export function contentHeight(rows: number, columns = 180, hasNotice = false): number {
  const editorHeight = 3;
  const footerHeight = 1;
  return Math.max(5, rows - headerHeight(columns) - editorHeight - footerHeight - (hasNotice ? 1 : 0));
}

export function panelHeights(
  columns: number,
  rows: number,
  inspectorVisible: boolean,
  hasNotice = false,
  viewMode: ViewMode = "both",
): { content: number; lane: number; inspector: number; showInspector: boolean } {
  const layout = selectLayout(columns, viewMode);
  const content = contentHeight(rows, columns, hasNotice);
  const showInspector = inspectorVisible && (columns >= 100 || (viewMode === "focused" && content >= 15));
  if (layout === "focused" && showInspector) {
    const usable = content - 1;
    const inspector = Math.max(6, Math.floor(usable * 0.35));
    return { content, lane: usable - inspector, inspector, showInspector };
  }
  if (layout === "stacked") {
    return { content, lane: Math.floor((content - 1) / 2), inspector: content, showInspector };
  }
  return { content, lane: content, inspector: content, showInspector };
}

export function panelWidths(
  columns: number,
  inspectorVisible: boolean,
  viewMode: ViewMode = "both",
): { lanes: number; inspector: number } {
  if (!inspectorVisible || selectLayout(columns, viewMode) === "focused") return { lanes: columns, inspector: 0 };
  const usable = columns - 1;
  const lanes = Math.floor(usable * 0.66);
  return { lanes, inspector: usable - lanes };
}

export function laneOutputHeight(
  columns: number,
  rows: number,
  inspectorVisible: boolean,
  hasError = false,
  hasNotice = false,
  viewMode: ViewMode = "both",
): number {
  const { lane } = panelHeights(columns, rows, inspectorVisible, hasNotice, viewMode);
  const compactBoth = columns < 100 && viewMode === "both";
  return Math.max(2, lane - (compactBoth ? 4 : 6) - (hasError ? 2 : 0));
}
