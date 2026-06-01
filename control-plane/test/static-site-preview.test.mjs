import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStaticSiteSnapshot } from "../src/static-site-preview.mjs";

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "beep-static-preview-test-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("static site snapshot is independent of later workspace changes", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>original</h1>\n");

    const snapshot = createStaticSiteSnapshot({
      sourceHostPath: source,
      siteId: "demo-site",
      snapshotRoot,
    });

    writeFileSync(join(source, "index.html"), "<h1>mutated</h1>\n");

    assert.equal(readFileSync(join(snapshot.snapshotPath, "index.html"), "utf8"), "<h1>original</h1>\n");
    assert.equal(snapshot.fileCount, 1);
    assert.equal(snapshot.totalBytes, "<h1>original</h1>\n".length);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects secret-like files instead of serving them", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(source, ".env"), "TOKEN=secret\n");

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
        }),
      /secret or credential/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects symlinked directories during traversal", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const outside = join(dir, "outside");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(source, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(outside, join(source, "assets"));

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
        }),
      /symlink/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects symlinked parent components under the trusted root", () => {
  const { dir, cleanup } = tempDir();
  try {
    const trustedRoot = join(dir, "workspace");
    const outside = join(dir, "outside");
    const source = join(trustedRoot, "api-sessions", "agent_beep", "site");
    const snapshotRoot = join(dir, "snapshots");
    mkdirSync(trustedRoot, { recursive: true });
    mkdirSync(join(outside, "agent_beep", "site"), { recursive: true });
    writeFileSync(join(outside, "agent_beep", "site", "index.html"), "<h1>outside</h1>\n");
    symlinkSync(outside, join(trustedRoot, "api-sessions"));

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
          trustedRoot,
        }),
      /symlink/iu,
    );
    assert.equal(existsSync(join(snapshotRoot, "demo-site")), false);
  } finally {
    cleanup();
  }
});

test("static site snapshot rejects snapshot roots inside the source tree", () => {
  const { dir, cleanup } = tempDir();
  try {
    const source = join(dir, "workspace-site");
    const snapshotRoot = join(source, "snapshots");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "index.html"), "<h1>demo</h1>\n");

    assert.throws(
      () =>
        createStaticSiteSnapshot({
          sourceHostPath: source,
          siteId: "demo-site",
          snapshotRoot,
          maxFiles: 4,
        }),
      /snapshot root must not be inside the source tree/iu,
    );
    assert.equal(existsSync(snapshotRoot), false);
  } finally {
    cleanup();
  }
});
