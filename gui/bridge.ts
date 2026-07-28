import type { AppSnapshot } from "../src/domain.ts";

/** The only channel between the Electron main process and its renderer. It is
 * one-way by construction: the renderer never sends, so there is no path from a
 * window to a session. See `docs/GUI_TRANSITION_DECISIONS.md`. */
export const MIRROR_CHANNEL = "splitlane:mirror-state";

export type MirrorStatus =
  /** No session is publishing for this project yet. */
  | "waiting"
  /** Attached to a live session; `snapshot` is current. */
  | "attached"
  /** The session ended. The last snapshot is kept but labelled stale. */
  | "detached"
  /** Something answered on the endpoint but is not a session for this project. */
  | "mismatch"
  /** Local failure — unreadable configuration, bad project path. */
  | "error";

export interface MirrorState {
  status: MirrorStatus;
  projectRoot: string;
  sessionVersion: string | null;
  detail: string | null;
  snapshot: AppSnapshot | null;
}
