import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ProviderId, WriterLease } from "../domain.ts";

const authenticLeases = new WeakSet<WriterLease>();

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

export function isPathInsideWorkspace(projectRoot: string, requestedPath: string): boolean {
  const root = canonicalPath(projectRoot);
  const lexical = resolve(projectRoot, requestedPath);
  if (!within(resolve(projectRoot), lexical)) return false;

  let existing = lexical;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }
  const canonicalExisting = canonicalPath(existing);
  return within(root, canonicalExisting);
}

export function isAuthenticWriterLease(
  lease: WriterLease | null,
  provider: ProviderId,
  projectRoot: string,
): lease is WriterLease {
  return Boolean(
    lease &&
    authenticLeases.has(lease) &&
    lease.provider === provider &&
    canonicalPath(lease.projectRoot) === canonicalPath(projectRoot),
  );
}

export class WorkspaceGuard {
  readonly #projectRoot: string;
  #active: WriterLease | null = null;

  constructor(projectRoot: string) {
    this.#projectRoot = canonicalPath(projectRoot);
  }

  get active(): WriterLease | null {
    return this.#active;
  }

  grant(provider: ProviderId, baselineFingerprint: string): WriterLease {
    if (this.#active) throw new Error(`Writer lease already belongs to ${this.#active.provider}`);
    const lease: WriterLease = Object.freeze({
      id: randomUUID(),
      provider,
      projectRoot: this.#projectRoot,
      grantedAt: new Date().toISOString(),
      baselineFingerprint,
    });
    authenticLeases.add(lease);
    this.#active = lease;
    return lease;
  }

  validate(lease: WriterLease | null, provider: ProviderId): lease is WriterLease {
    return this.#active === lease && isAuthenticWriterLease(lease, provider, this.#projectRoot);
  }

  revoke(leaseId: string): boolean {
    if (!this.#active || this.#active.id !== leaseId) return false;
    authenticLeases.delete(this.#active);
    this.#active = null;
    return true;
  }
}
