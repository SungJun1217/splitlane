import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installer = join(repositoryRoot, "scripts", "install.sh");
const targetAsset =
  process.platform === "darwin" && process.arch === "arm64"
    ? "splitlane-darwin-arm64"
    : process.platform === "linux" && process.arch === "x64"
      ? "splitlane-linux-x64"
      : undefined;

async function fixture(binaryContents, checksum) {
  const root = await mkdtemp(join(tmpdir(), "splitlane-installer-test-"));
  const release = join(root, "release");
  const installDir = join(root, "bin");
  const asset = targetAsset;
  await mkdir(release);
  await writeFile(join(release, asset), binaryContents);
  await writeFile(join(release, "SHA256SUMS"), `${checksum}  ${asset}\n`);
  return { root, release, installDir };
}

function installerEnvironment(release, installDir) {
  return {
    ...process.env,
    SPLITLANE_INSTALL_DIR: installDir,
    SPLITLANE_RELEASE_BASE_URL: pathToFileURL(release).href,
  };
}

test("installer verifies and installs the matching release asset", { skip: !targetAsset }, async () => {
  const contents = "#!/bin/sh\nprintf 'splitlane fixture\\n'\n";
  const checksum = createHash("sha256").update(contents).digest("hex");
  const { root, release, installDir } = await fixture(contents, checksum);

  try {
    const result = await execFileAsync("/bin/sh", [installer], {
      cwd: repositoryRoot,
      env: installerEnvironment(release, installDir),
    });
    const installed = join(installDir, "splitlane");
    assert.match(result.stdout, /Installed Splitlane/);
    assert.equal(await readFile(installed, "utf8"), contents);
    assert.equal(await readFile(join(installDir, ".splitlane-managed"), "utf8"), "splitlane-managed/v1\nSungJun1217/splitlane\n");
    await chmod(installed, 0o755);
    const executed = await execFileAsync(installed);
    assert.equal(executed.stdout, "splitlane fixture\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer rejects a bad checksum without replacing an existing binary", { skip: !targetAsset }, async () => {
  const { root, release, installDir } = await fixture("untrusted", "0".repeat(64));
  const installed = join(installDir, "splitlane");

  try {
    await mkdir(installDir);
    await writeFile(installed, "existing");
    await assert.rejects(
      execFileAsync("/bin/sh", [installer], {
        cwd: repositoryRoot,
        env: installerEnvironment(release, installDir),
      }),
      (error) => {
        assert.match(error.stderr, /checksum verification failed/);
        return true;
      },
    );
    assert.equal(await readFile(installed, "utf8"), "existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
