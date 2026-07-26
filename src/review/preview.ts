import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ReviewFilePreview, ReviewFinding } from "../domain.ts";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";
import { isPathInsideWorkspace } from "../workspace/guard.ts";

const PREVIEW_LIMIT = 256 * 1024;

export async function loadFindingPreview(projectRoot: string, finding: ReviewFinding): Promise<ReviewFilePreview | null> {
  if (!finding.file) return null;
  const base = { file: finding.file, lineStart: finding.lineStart, lineEnd: finding.lineEnd };
  if (!isPathInsideWorkspace(projectRoot, finding.file)) {
    return { ...base, content: "", error: "Finding path is outside the project or escapes through a symlink." };
  }
  try {
    const canonical = await realpath(resolve(projectRoot, finding.file));
    if (!isPathInsideWorkspace(projectRoot, canonical)) {
      return { ...base, content: "", error: "Finding path resolves outside the project." };
    }
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) return { ...base, content: "", error: "Finding location is not a regular file." };
      if (metadata.size > PREVIEW_LIMIT) return { ...base, content: "", error: "Finding file exceeds the 256 KiB preview limit." };
      const bytes = await handle.readFile();
      if (bytes.includes(0)) return { ...base, content: "", error: "Binary finding files are not previewed." };
      const lines = bytes.toString("utf8").split("\n");
      const target = Math.max(1, finding.lineStart ?? 1);
      const start = Math.max(1, target - 3);
      const end = Math.min(lines.length, Math.max(finding.lineEnd ?? target, target) + 3);
      const content = lines.slice(start - 1, end).map((line, index) => `${String(start + index).padStart(5)} │ ${line}`).join("\n");
      return { ...base, content: sanitizeTerminalText(content), error: null };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { ...base, content: "", error: sanitizeTerminalText((error as Error).message) || "Finding file is unavailable." };
  }
}
