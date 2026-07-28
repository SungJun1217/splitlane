import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AppSnapshot } from "../domain.ts";

export const MIRROR_PROTOCOL = "splitlane-mirror/v1";

/** The publisher only ever sends these. There is deliberately no frame a reader
 * can send back: the mirror carries no authority, and enforcing that in the
 * protocol is stronger than trusting every future renderer to behave. */
export type MirrorFrame =
  | { type: "hello"; protocol: string; version: string; projectRoot: string; readOnly: true }
  | { type: "snapshot"; snapshot: AppSnapshot };

/** A socket path has a hard length limit (104 bytes on macOS) that the state
 * directory plus a full project hash would exceed, so the identity is truncated.
 * A truncated collision cannot leak authority — the reader verifies the project
 * root in the hello frame and detaches on a mismatch. */
export function mirrorEndpoint(stateDirectory: string, projectRoot: string, platform: NodeJS.Platform = process.platform): string {
  const identity = createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  return platform === "win32"
    ? `\\\\.\\pipe\\splitlane-mirror-${identity}`
    : join(stateDirectory, "mirror", `${identity}.sock`);
}

export function encodeFrame(frame: MirrorFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Newline-delimited JSON, so a reader that arrives mid-frame keeps the partial
 * tail instead of discarding a snapshot. Unparsable lines are dropped rather
 * than thrown: a reader must not die on a frame it does not understand. */
export function decodeFrames(buffered: string): { frames: MirrorFrame[]; rest: string } {
  const lines = buffered.split("\n");
  const rest = lines.pop() ?? "";
  const frames: MirrorFrame[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MirrorFrame;
      if (parsed.type === "hello" || parsed.type === "snapshot") frames.push(parsed);
    } catch {}
  }
  return { frames, rest };
}
