// The sandbox's own guard: removeInSandbox removes only what is inside the
// sandbox, so a test that deletes a path setup recorded can never delete the
// host's file behind it (Homebrew's node, through /opt/homebrew/opt/node, a
// link into the keg).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inSandbox, removeInSandbox } from "./helpers/sandbox.mjs";

test("removeInSandbox: a file or link inside the sandbox goes; a path whose directory resolves outside it is refused and kept", (t) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "oats-omarchy-guard-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "sandbox");
  const host = join(base, "host", "Cellar", "node", "bin");
  mkdirSync(root);
  mkdirSync(host, { recursive: true });
  const node = join(host, "node");
  writeFileSync(node, "the host's node");

  const mine = join(root, "file");
  writeFileSync(mine, "x");
  removeInSandbox(root, mine);
  assert.equal(existsSync(mine), false);

  const link = join(root, "node");
  symlinkSync(node, link);
  removeInSandbox(root, link);
  assert.equal(existsSync(link), false, "the link goes");
  assert.equal(existsSync(node), true, "and only the link");

  // As Homebrew's opt/node: a directory link in the sandbox, into the host.
  symlinkSync(join(base, "host", "Cellar", "node"), join(root, "opt"));
  assert.throws(() => removeInSandbox(root, join(root, "opt", "bin", "node")), /refusing to remove .*: it is outside the sandbox/);
  assert.throws(() => removeInSandbox(root, node), /outside the sandbox/);
  assert.equal(existsSync(node), true, "the host's file is kept");
  // A link followed by "..": the OS follows the link first, so this names a
  // file beside the link's target, outside the sandbox (never path.join,
  // which would drop the ".." before anything resolves).
  symlinkSync(host, join(root, "bin"));
  const beside = join(base, "host", "Cellar", "node", "sentinel");
  writeFileSync(beside, "the host's file");
  assert.throws(() => removeInSandbox(root, `${root}/bin/../sentinel`), /outside the sandbox/);
  assert.equal(existsSync(beside), true, "the host's file beside the link's target is kept");
  assert.deepEqual([inSandbox(root, join(root, "x")), inSandbox(root, join(root, "opt", "bin", "node")), inSandbox(root, node)], [true, false, false]);
});
