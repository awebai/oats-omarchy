// "Pinning a release" in the README: the command it gives works as written
// on the plugin's checkout as Omarchy leaves it, after `omarchy plugin add`
// and after `omarchy plugin update`. The update runs `git fetch --quiet
// origin HEAD` then `git merge --ff-only FETCH_HEAD` (Omarchy 4.0.4's
// bin/omarchy-plugin-update), which brings no tags, so a release tagged
// after the add is not in the checkout until the pin fetches it. Real git,
// on repositories in a temporary HOME; nothing is fetched from the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repo } from "./helpers/sandbox.mjs";

const README = readFileSync(join(repo, "README.md"), "utf8");

// Every pin command the README gives: each line, or each `code` span, that
// checks out a release tag in the plugin's checkout.
function pinCommands() {
  const out = [];
  for (const line of README.split("\n")) {
    if (!/checkout v\d/.test(line)) continue;
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((s) => /checkout v\d/.test(s));
    out.push(...(spans.length ? spans : [line.trim()]));
  }
  return out;
}

function machine(t) {
  const root = mkdtempSync(join(tmpdir(), "oats-pin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (cwd, ...args) => {
    const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = join(root, "origin.git");
  const upstream = join(root, "upstream");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", upstream);
  const commit = (name) => { writeFileSync(join(upstream, name), name); git(upstream, "add", name); git(upstream, "commit", "-q", "-m", name); return git(upstream, "rev-parse", "HEAD"); };
  const tag = (name) => git(upstream, "tag", name);
  const push = () => git(upstream, "push", "-q", "--tags", origin, "main");
  const plugin = join(home, ".config", "omarchy", "plugins", "ai.aweb.oats");
  const add = () => { mkdirSync(join(home, ".config", "omarchy", "plugins"), { recursive: true }); git(root, "clone", "-q", "--", origin, plugin); };
  const update = () => { git(plugin, "fetch", "--quiet", "origin", "HEAD"); git(plugin, "merge", "--ff-only", "FETCH_HEAD"); };
  // The command as the person types it, in bash, with this HOME.
  const type = (command) => spawnSync("bash", ["-c", command], { cwd: home, env, encoding: "utf8" });
  return { git, commit, tag, push, plugin, add, update, type };
}

test("the README gives one pin command, everywhere it gives one, and it fetches the tag it checks out", () => {
  const pins = pinCommands();
  assert.ok(pins.length >= 3, JSON.stringify(pins));
  assert.deepEqual([...new Set(pins)], [pins[0]], "the same command each time");
  const tag = /checkout (v\d+\.\d+\.\d+)/.exec(pins[0])[1];
  assert.match(pins[0], new RegExp(`fetch .*origin tag ${tag.replace(/\./g, "\\.")}\\b`));
});

test("pinning after omarchy plugin update: the update brought no tags, and the README's command still checks out the release", (t) => {
  const m = machine(t);
  const pin = pinCommands()[0];
  const tag = /checkout (v\d+\.\d+\.\d+)/.exec(pin)[1];
  m.commit("first");
  m.push();
  m.add();
  const release = m.commit("release");
  m.tag(tag);
  m.commit("after the release");
  m.push();
  m.update();
  assert.equal(m.git(m.plugin, "tag", "-l"), "", "omarchy plugin update fetches no tags (awebai/oats-omarchy#25)");
  assert.notEqual(m.type(`git -C ~/.config/omarchy/plugins/ai.aweb.oats checkout ${tag}`).status, 0, "a checkout alone fails here");
  const r = m.type(pin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(m.git(m.plugin, "rev-parse", "HEAD"), release);
});

test("pinning right after omarchy plugin add, with the tag already there, works the same", (t) => {
  const m = machine(t);
  const pin = pinCommands()[0];
  const tag = /checkout (v\d+\.\d+\.\d+)/.exec(pin)[1];
  m.commit("first");
  const release = m.commit("release");
  m.tag(tag);
  m.commit("after the release");
  m.push();
  m.add();
  const r = m.type(pin);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(m.git(m.plugin, "rev-parse", "HEAD"), release);
});
