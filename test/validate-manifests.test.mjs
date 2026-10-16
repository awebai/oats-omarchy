// npm run validate, and proof that it refuses what it must refuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validator = join(repo, "scripts", "validate-manifests.mjs");
const fixtures = join(repo, "test", "fixtures", "validate");
const capDir = "oats-package/capabilities/oats-omarchy";

const validate = (...args) => spawnSync(process.execPath, [validator, ...args], { encoding: "utf8" });

// A scratch copy of this repository's payload, to break one thing at a time.
function scratchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "oats-omarchy-validate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(repo, "oats-package"), join(dir, "oats-package"), { recursive: true });
  return dir;
}
const editJson = (path, edit) => writeFileSync(path, JSON.stringify(edit(JSON.parse(readFileSync(path, "utf8"))), null, 2));

test("the repository's payload validates", () => {
  const r = validate();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Validated oats-package\/oats-package.json and 1 capability manifest/);
});

test("a scratch copy of the payload validates (the baseline the refusals below break)", (t) => {
  const r = validate("--repo", scratchRepo(t));
  assert.equal(r.status, 0, r.stderr);
});

test("a fixture manifest whose command path escapes the payload root is refused", () => {
  const r = validate("--repo", join(fixtures, "escaping-path"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commands\.run: path "\.\.\/\.\.\/\.\.\/outside\.mjs" must be relative, use forward slashes and contain no '\.\.'/);
});

test("a fixture oats.json at the repository root, outside the payload, is refused", () => {
  const r = validate("--repo", join(fixtures, "root-manifest"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /- oats\.json: manifest outside the payload root/);
  assert.doesNotMatch(r.stderr, /capabilities\/x/, "the payload itself is valid; only the stray manifest is refused");
});

test("a command entrypoint that is a symlink out of the payload is refused", (t) => {
  const dir = scratchRepo(t);
  writeFileSync(join(dir, "outside.mjs"), "// outside the payload\n");
  rmSync(join(dir, capDir, "bin", "oats-omarchy.mjs"));
  symlinkSync(join(dir, "outside.mjs"), join(dir, capDir, "bin", "oats-omarchy.mjs"));
  const r = validate("--repo", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /escapes oats-package after symlink resolution/);
});

test("a skill tree that links out of its capability root is refused", (t) => {
  const dir = scratchRepo(t);
  // Inside the payload, but outside the capability root a spawn copies.
  cpSync(join(dir, capDir, "skills"), join(dir, "oats-package", "elsewhere"), { recursive: true });
  rmSync(join(dir, capDir, "skills"), { recursive: true });
  symlinkSync(join(dir, "oats-package", "elsewhere"), join(dir, capDir, "skills"));
  const r = validate("--repo", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /skills\[0\]: escapes oats-package\/capabilities\/oats-omarchy after symlink resolution/);
});

test("both manifests are checked against the vendored schemas", (t) => {
  const dir = scratchRepo(t);
  editJson(join(dir, "oats-package", "oats-package.json"), ({ description, ...rest }) => rest);
  editJson(join(dir, capDir, "oats.json"), (m) => ({ ...m, command: "Not A Namespace", surprise: true }));
  const r = validate("--repo", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /oats-package\.json: missing required property description/);
  assert.match(r.stderr, /oats\.json\.command: must match/);
  assert.match(r.stderr, /oats\.json\.surprise: unknown property/);
});

test("the package and its one capability agree on id, version and kernel floor", (t) => {
  const dir = scratchRepo(t);
  editJson(join(dir, "oats-package", "oats-package.json"), (m) => ({ ...m, package: "oats.other", version: "9.9.9", compatibility: { oats: ">=0.1.0" } }));
  const r = validate("--repo", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /oats-package\.json\.package: must equal the capability id oats\.omarchy/);
  assert.match(r.stderr, /oats-package\.json\.version: must equal the capability version/);
  assert.match(r.stderr, /oats-package\.json\.compatibility\.oats: must equal/);
});

test("a declared command whose script is missing is refused", (t) => {
  const dir = scratchRepo(t);
  editJson(join(dir, capDir, "oats.json"), (m) => ({ ...m, commands: { ...m.commands, gone: "bin/gone.mjs" } }));
  const r = validate("--repo", dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /commands\.gone: cannot be resolved \(ENOENT\)/);
});
