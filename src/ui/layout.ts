export type LayoutMode = "focused" | "split";
export type ViewMode = "both" | "focused";

/** Rows a lane box spends on its own frame: borders, status, model, and in the
 * wide layout the shared-context and activity rows. Keep in sync with `Lane`. */
export const LANE_CHROME_COMPACT = 4;
export const LANE_CHROME_FULL = 6;
export const MIN_LANE_OUTPUT_ROWS = 1;
export const EDITOR_HEIGHT = 3;
export const FOOTER_HEIGHT = 1;
export const MIN_COLUMNS = 60;

export function selectLayout(columns: number, viewMode: ViewMode = "both"): LayoutMode {
  if (viewMode === "focused") return "focused";
  return "split";
}

export function headerHeight(columns: number): number {
  return columns < 100 ? 4 : 3;
}

export function laneChrome(columns: number, viewMode: ViewMode = "both"): number {
  return columns < 100 && viewMode === "both" ? LANE_CHROME_COMPACT : LANE_CHROME_FULL;
}

export function contentHeight(rows: number, columns = 180, hasNotice = false): number {
  return Math.max(0, rows - headerHeight(columns) - EDITOR_HEIGHT - FOOTER_HEIGHT - (hasNotice ? 1 : 0));
}

/** Smallest terminal height that can render every declared row without
 * overprinting a border. Lanes are stacked, so each one needs its own frame
 * plus at least one output row, and stacked lanes are separated by one gap. */
export function minimumRows(columns: number, viewMode: ViewMode = "both", hasNotice = false): number {
  const laneCount = viewMode === "both" ? 2 : 1;
  const perLane = laneChrome(columns, viewMode) + MIN_LANE_OUTPUT_ROWS;
  return headerHeight(columns)
    + perLane * laneCount
    + (laneCount - 1)
    + EDITOR_HEIGHT
    + FOOTER_HEIGHT
    + (hasNotice ? 1 : 0);
}

export function fitsTerminal(columns: number, rows: number, viewMode: ViewMode = "both", hasNotice = false): boolean {
  return columns >= MIN_COLUMNS && rows >= minimumRows(columns, viewMode, hasNotice);
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
    return { content, lane: Math.max(0, usable - inspector), inspector, showInspector };
  }
  if (layout === "focused") return { content, lane: content, inspector: content, showInspector };
  return { content, lane: Math.max(0, Math.floor((content - 1) / 2)), inspector: content, showInspector };
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
  return laneOutputRows(lane, laneChrome(columns, viewMode), hasError);
}

/** Output rows a lane box may draw without pushing past its declared height. */
export function laneOutputRows(laneHeight: number, chrome: number, hasError = false): number {
  return Math.max(MIN_LANE_OUTPUT_ROWS, laneHeight - chrome - (hasError ? 2 : 0));
}
