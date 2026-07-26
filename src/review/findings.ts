import { isAbsolute, relative, resolve } from "node:path";
import type { ProviderId, ReviewEnvelope, ReviewFinding, ReviewMechanism, ReviewSeverity } from "../domain.ts";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";

export const FINDINGS_START = "<<<SPLITLANE_FINDINGS_V1>>>";
export const FINDINGS_END = "<<<END_SPLITLANE_FINDINGS_V1>>>";
const SEVERITIES = new Set<ReviewSeverity>(["blocker", "high", "medium", "low", "info"]);

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const result = sanitizeTerminalText(value).trim().slice(0, max);
  return result || null;
}

function line(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function reviewPath(root: string, value: unknown): string | null {
  const path = clean(value, 2_000);
  if (!path) return null;
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return null;
  return fromRoot;
}

export function parseReviewFindings(
  output: string,
  provider: ProviderId,
  mechanism: ReviewMechanism,
  projectRoot: string,
): { findings: ReviewFinding[]; error: string | null } {
  const start = output.indexOf(FINDINGS_START);
  const end = start < 0 ? -1 : output.indexOf(FINDINGS_END, start + FINDINGS_START.length);
  if (start < 0 || end < 0) return { findings: [], error: "Reviewer output did not contain a complete findings envelope." };
  const encoded = output.slice(start + FINDINGS_START.length, end).trim();
  if (Buffer.byteLength(encoded, "utf8") > 128 * 1024) return { findings: [], error: "Findings envelope exceeded 128 KiB." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return { findings: [], error: "Findings envelope was not valid JSON." };
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  if (!Array.isArray(record.findings) || record.findings.length > 100) {
    return { findings: [], error: "Findings envelope must contain at most 100 findings." };
  }
  const findings: ReviewFinding[] = [];
  const ids = new Set<string>();
  for (const value of record.findings) {
    const item = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const id = clean(item.id, 120);
    const severity = clean(item.severity, 20) as ReviewSeverity | null;
    const title = clean(item.title, 500);
    const body = clean(item.body, 8_000);
    if (!id || !severity || !SEVERITIES.has(severity) || !title || !body) {
      return { findings: [], error: "A finding failed review-findings/v1 validation." };
    }
    if (ids.has(id)) return { findings: [], error: "Finding IDs must be unique." };
    ids.add(id);
    const fileValue = clean(item.file, 2_000);
    const file = reviewPath(projectRoot, fileValue);
    if (fileValue && !file) return { findings: [], error: "A finding referenced a path outside the project." };
    const lineStart = line(item.lineStart);
    const requestedEnd = line(item.lineEnd);
    const lineEnd = requestedEnd && lineStart && requestedEnd >= lineStart ? requestedEnd : lineStart;
    findings.push({
      id,
      provider,
      mechanism,
      severity,
      title,
      body,
      file,
      lineStart: file ? lineStart : null,
      lineEnd: file ? lineEnd : null,
      verification: clean(item.verification, 2_000),
      selected: false,
    });
  }
  return { findings, error: null };
}

export function buildReviewPrompt(envelope: ReviewEnvelope): string {
  return [
    "You are the read-only reviewer in Splitlane. Review only the frozen patch below.",
    `Objective: ${envelope.objective}`,
    `Acceptance criteria: ${envelope.acceptanceCriteria}`,
    `Envelope: ${envelope.id} · SHA-256 ${envelope.diffHash}`,
    "Return one schema-valid JSON object between the exact sentinels below. Do not place prose inside the sentinels.",
    FINDINGS_START,
    '{"findings":[{"id":"stable-id","severity":"blocker|high|medium|low|info","title":"short title","body":"exact finding text","file":"relative/path or null","lineStart":1,"lineEnd":1,"verification":"optional"}]}',
    FINDINGS_END,
    "An empty review must use {\"findings\":[]}.",
    "Frozen patch:",
    envelope.diff,
  ].join("\n\n");
}

export function buildFindingsRelay(envelope: ReviewEnvelope, findings: readonly ReviewFinding[]): string {
  const selected = findings.filter((finding) => finding.selected);
  return [
    `Address the user-selected review findings for envelope ${envelope.id} (${envelope.diffHash}).`,
    ...selected.map((finding) => [
      `[${finding.severity.toUpperCase()}] ${finding.title}`,
      `finding: ${finding.id}`,
      `source: ${finding.provider} via ${finding.mechanism}`,
      `location: ${finding.file ?? "general"}${finding.lineStart ? `:${finding.lineStart}` : ""}`,
      finding.body,
      ...(finding.verification ? [`verification: ${finding.verification}`] : []),
    ].join("\n")),
  ].join("\n\n");
}
