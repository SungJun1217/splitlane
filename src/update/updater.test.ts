import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { StandaloneUpdater, compareVersions } from "./updater.ts";

const repository = "SungJun1217/splitlane";
const tag = "v0.0.5";
const assetName = "splitlane-linux-x64";
const assetUrl = `https://github.com/${repository}/releases/download/${tag}/${assetName}`;
const sumsUrl = `https://github.com/${repository}/releases/download/${tag}/SHA256SUMS`;
const releaseUrl = `https://api.github.com/repos/${repository}/releases/latest`;

function releaseFetch(binary: string, checksum = createHash("sha256").update(binary).digest("hex")) {
  const calls: string[] = [];
  const fetchFn = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === releaseUrl) {
      return Response.json({
        tag_name: tag,
        draft: false,
        prerelease: false,
        assets: [
          { name: assetName, browser_download_url: assetUrl, size: Buffer.byteLength(binary) },
          { name: "SHA256SUMS", browser_download_url: sumsUrl, size: 96 },
        ],
      });
    }
    if (url === sumsUrl) return new Response(`${checksum}  ${assetName}\n`);
    if (url === assetUrl) return new Response(binary, { headers: { "content-length": String(Buffer.byteLength(binary)) } });
    return new Response("not found", { status: 404 });
  };
  return { fetchFn: fetchFn as typeof fetch, calls };
}

async function installation(): Promise<{ root: string; executable: string; existing: string }> {
  const root = await mkdtemp(join(tmpdir(), "splitlane-updater-"));
  const executable = join(root, "bin", "splitlane");
  const existing = "#!/bin/sh\nprintf '0.0.4\\n'\n";
  await mkdir(join(root, "bin"));
  await writeFile(executable, existing, { mode: 0o755 });
  await writeFile(join(root, "bin", ".splitlane-managed"), `splitlane-managed/v1\n${repository}\n`, { mode: 0o600 });
  return { root, executable, existing };
}

function updater(root: string, executable: string, fetchFn: typeof fetch, mode: "auto" | "notify" | "off" = "auto", now = new Date("2026-07-27T00:00:00.000Z")) {
  return new StandaloneUpdater({
    currentVersion: "0.0.4",
    executablePath: executable,
    stateDirectory: join(root, "state"),
    mode,
    platform: "linux",
    arch: "x64",
    fetchFn,
    now: () => now,
  });
}

describe("standalone updater", () => {
  test("compares stable versions without allowing prerelease ambiguity", () => {
    expect(compareVersions("0.0.4", "0.0.5")).toBe(-1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(() => compareVersions("latest", "1.0.0")).toThrow("Invalid stable SemVer");
  });

  test("verifies and atomically replaces a supported standalone executable", async () => {
    const { root, executable } = await installation();
    const binary = "#!/bin/sh\n[ \"$1\" = \"--version\" ] && printf '0.0.5\\n'\n";
    const fixture = releaseFetch(binary);
    try {
      const service = updater(root, executable, fixture.fetchFn);
      const result = await service.start();
      expect(result).toMatchObject({ outcome: "updated", currentVersion: "0.0.4", latestVersion: "0.0.5", checked: true });
      expect(await readFile(executable, "utf8")).toBe(binary);
      expect(fixture.calls).toEqual([releaseUrl, sumsUrl, assetUrl]);
      expect(JSON.parse(await readFile(service.statePath, "utf8"))).toMatchObject({
        schemaVersion: "update-state/v1",
        latestVersion: "0.0.5",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("notify mode checks without downloading or replacing the executable", async () => {
    const { root, executable, existing } = await installation();
    const fixture = releaseFetch("new binary");
    try {
      const result = await updater(root, executable, fixture.fetchFn, "notify").start();
      expect(result.outcome).toBe("available");
      expect(result.message).toContain("splitlane update");
      expect(await readFile(executable, "utf8")).toBe(existing);
      expect(fixture.calls).toEqual([releaseUrl]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("bad checksums preserve the existing executable", async () => {
    const { root, executable, existing } = await installation();
    const fixture = releaseFetch("untrusted", "0".repeat(64));
    try {
      const result = await updater(root, executable, fixture.fetchFn).start();
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain("preserved");
      expect(await readFile(executable, "utf8")).toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a downloaded executable with the wrong version is never installed", async () => {
    const { root, executable, existing } = await installation();
    const binary = "#!/bin/sh\n[ \"$1\" = \"--version\" ] && printf '9.9.9\\n'\n";
    const fixture = releaseFetch(binary);
    try {
      const result = await updater(root, executable, fixture.fetchFn).start();
      expect(result.outcome).toBe("failed");
      expect(result.message).toContain("expected 0.0.5");
      expect(await readFile(executable, "utf8")).toBe(existing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("daily cadence, off mode, and symlinks make no network request", async () => {
    const { root, executable } = await installation();
    const fixture = releaseFetch("unused");
    try {
      await mkdir(join(root, "state"));
      const automatic = updater(root, executable, fixture.fetchFn);
      await writeFile(automatic.statePath, JSON.stringify({ schemaVersion: "update-state/v1", checkedAt: "2026-07-26T12:00:00.000Z", latestVersion: "0.0.4" }));
      expect((await automatic.start()).checked).toBe(false);
      expect((await updater(root, executable, fixture.fetchFn, "off").start()).outcome).toBe("disabled");
      const unmanaged = join(root, "unmanaged", "splitlane");
      await mkdir(join(root, "unmanaged"));
      await writeFile(unmanaged, "unmanaged", { mode: 0o755 });
      expect((await updater(root, unmanaged, fixture.fetchFn).start(true)).outcome).toBe("unsupported");
      const linked = join(root, "linked", "splitlane");
      await mkdir(join(root, "linked"));
      await writeFile(join(root, "linked", ".splitlane-managed"), `splitlane-managed/v1\n${repository}\n`);
      await symlink(executable, linked);
      expect((await updater(root, linked, fixture.fetchFn).start(true)).outcome).toBe("unsupported");
      expect(fixture.calls).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("manual force bypasses notify mode and the daily cadence", async () => {
    const { root, executable } = await installation();
    const binary = "#!/bin/sh\n[ \"$1\" = \"--version\" ] && printf '0.0.5\\n'\n";
    const fixture = releaseFetch(binary);
    try {
      await mkdir(join(root, "state"));
      const service = updater(root, executable, fixture.fetchFn, "notify");
      await writeFile(service.statePath, JSON.stringify({ schemaVersion: "update-state/v1", checkedAt: "2026-07-27T00:00:00.000Z", latestVersion: "0.0.5" }));
      expect((await service.start(true)).outcome).toBe("updated");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("shutdown aborts an in-flight background release check", async () => {
    const { root, executable } = await installation();
    let started = false;
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      started = true;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;
    try {
      const service = updater(root, executable, fetchFn);
      const pending = service.start();
      while (!started) await Bun.sleep(1);
      await service.close();
      expect((await pending).outcome).toBe("failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
