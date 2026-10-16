// The command surface: the manifest the kernel dispatches from and the
// executable behind it. Setup's own behaviour is test/setup.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capRoot = join(repo, "oats-package", "capabilities", "oats-omarchy");
const bin = join(capRoot, "bin", "oats-omarchy.mjs");
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8" });

test("the capability manifest declares the omarchy namespace, its commands and its skills", () => {
  const manifest = JSON.parse(readFileSync(join(capRoot, "oats.json"), "utf8"));
  assert.equal(manifest.capability, "oats.omarchy");
  assert.equal(manifest.command, "omarchy");
  assert.deepEqual(manifest.commands, { setup: "bin/oats-omarchy.mjs setup", waiting: "bin/oats-omarchy.mjs waiting" });
  assert.deepEqual(manifest.skills, ["skills"]);
});

test("--help prints the usage and exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^usage: oats omarchy <command>/);
  assert.match(r.stdout, /setup/);
  assert.match(r.stdout, /waiting/);
});

for (const args of [[], ["waiting"], ["--help", "extra"], ["bogus"]]) {
  test(`anything else exits 2: [${args.join(" ")}]`, () => {
    const r = run(...args);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /usage: oats omarchy <command>/);
  });
}

test("setup is dispatched: --help prints its usage, a bad argument exits 2", () => {
  const help = run("setup", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^usage: oats omarchy setup/);
  const bad = run("setup", "--bogus");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown argument: --bogus\nusage: oats omarchy setup/);
});
