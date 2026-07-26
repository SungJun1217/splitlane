import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProviderId, SessionHandle } from "../domain.ts";

export interface SessionRecord {
  schemaVersion: "session-state/v1";
  provider: ProviderId;
  sessionId: string;
  projectId: string;
  requestedModel: string;
  effectiveModel: string;
  providerVersion: string | null;
  createdAt: string;
  updatedAt: string;
  clean: boolean;
}

export function projectIdentity(projectRoot: string): string {
  return createHash("sha256").update(resolve(projectRoot)).digest("hex");
}

function validateRecord(value: unknown, path: string, provider: ProviderId, projectId: string): SessionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain a session-state/v1 object.`);
  const record = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "provider", "sessionId", "projectId", "requestedModel", "effectiveModel", "providerVersion", "createdAt", "updatedAt", "clean"];
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path}.${unknown} is unknown.`);
  if (record.schemaVersion !== "session-state/v1" || record.provider !== provider || record.projectId !== projectId) throw new Error(`${path} does not match this project/provider.`);
  for (const key of ["sessionId", "requestedModel", "effectiveModel", "createdAt", "updatedAt"] as const) {
    if (typeof record[key] !== "string" || !record[key]) throw new Error(`${path}.${key} must be a non-empty string.`);
  }
  if (record.providerVersion !== null && typeof record.providerVersion !== "string") throw new Error(`${path}.providerVersion must be a string or null.`);
  if (typeof record.clean !== "boolean") throw new Error(`${path}.clean must be boolean.`);
  return record as unknown as SessionRecord;
}

export class SessionStore {
  readonly projectId: string;
  readonly directory: string;

  constructor(readonly stateRoot: string, readonly projectRoot: string) {
    this.projectId = projectIdentity(projectRoot);
    this.directory = join(stateRoot, "sessions", this.projectId);
  }

  path(provider: ProviderId): string {
    return join(this.directory, `${provider}.json`);
  }

  async load(provider: ProviderId): Promise<SessionRecord | null> {
    const path = this.path(provider);
    try {
      return validateRecord(JSON.parse(await readFile(path, "utf8")), path, provider, this.projectId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) throw new Error(`${path} contains invalid JSON.`);
      throw error;
    }
  }

  async save(provider: ProviderId, session: SessionHandle, providerVersion: string | null, clean: boolean): Promise<SessionRecord> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existing = await this.load(provider);
    const now = new Date().toISOString();
    const record: SessionRecord = {
      schemaVersion: "session-state/v1",
      provider,
      sessionId: session.id,
      projectId: this.projectId,
      requestedModel: session.requestedModel,
      effectiveModel: session.effectiveModel,
      providerVersion,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      clean,
    };
    const temporary = join(this.directory, `.${provider}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path(provider));
    return record;
  }

  async remove(provider: ProviderId): Promise<void> {
    try { await unlink(this.path(provider)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
