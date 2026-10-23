// The node half of `omarchy-install-oats` (bin/install.mjs): the parts the
// POSIX sh installer leaves to node once node is there. `steward` answers
// --check's steward line with findSteward (lib/steward.mjs), through the
// `oats` the installer found, since setup's shim does not exist yet.
// `handoff` writes the found-list (docs/found-list.md, schemaVersion 1) and
// prints the onboarding prompt (lib/onboarding-prompt.txt) for the harness.
// Neither creates or changes anything but the found-list.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as discover from "./discover.mjs";
import { PLUGIN_DIR } from "./launch.mjs";
import { atomicWrite, makeDirs } from "./state.mjs";
import { findSteward, kernelMessage, stewardsIn } from "./steward.mjs";
import { which } from "./system.mjs";
import { listOf, statusRead } from "./waiting.mjs";

export const FOUND_SCHEMA = 1;
export const FOUND_FILE = "found.json";
export const HARNESSES = ["claude", "codex", "pi"];
export const SKILL = join("skills", "oats-getting-started", "SKILL.md");
export const PROMPT_FILE = join(PLUGIN_DIR, "lib", "onboarding-prompt.txt");
export const CHANNEL = "aweb-channel@awebai-marketplace";
const READ_TIMEOUT = 30_000;

// --check's steward line: "found <instance> @ <deployment>", or the reason.
// → { ok, line }.
export async function stewardLine(env, oats) {
  const r = await findSteward(env, { shim: oats, timeoutMs: READ_TIMEOUT });
  return r.ok ? { ok: true, line: `found ${r.instance} @ ${r.deployment.name}` } : { ok: false, line: `missing: ${r.reason}` };
}

// The installer's tools, one per line: name, version, origin, path and
// state, tab-separated, "-" for null. → the found-list's tools[].
export function parseTools(text) {
  return String(text).split("\n").filter((l) => l.trim()).map((line) => {
    const [name, version, origin, path, state] = line.split("\t").map((v) => (v === undefined || v === "-" || v === "" ? null : v));
    if (!name || !origin || !["found", "installed"].includes(state)) throw new Error(`a tool line the found-list cannot hold: ${JSON.stringify(line)}`);
    return { name, version, origin, path, state };
  });
}

// The getting-started skill of the OATS CLI at `oats` (its resolved path):
// the @awebai/oats package it belongs to, never a guess. → its path.
export function gettingStartedSkill(oats) {
  let dir;
  try { dir = dirname(realpathSync(oats)); } catch (e) { throw new Error(`the OATS CLI ${oats} cannot be resolved: ${e.message}`); }
  for (; dir !== dirname(dir); dir = dirname(dir)) {
    let pkg = null;
    try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { /* not a package root */ }
    if (pkg?.name === "@awebai/oats") {
      const skill = join(dir, SKILL);
      if (!existsSync(skill)) throw new Error(`the OATS CLI at ${dir} has no ${SKILL}`);
      return skill;
    }
  }
  throw new Error(`${oats} is not inside the @awebai/oats package`);
}

// The environment for `aw` in ~/Work: the parent's without any AWEB_* or
// AW_* selector, so that a session's own identity never answers for ~/Work.
export const awEnvironment = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(AWEB|AW)_/.test(k)));

// The ~/Work identity: { dir, alias, address, role }, or null without a
// ~/Work/.aw. `role` is "deployment-root" when ~/Work or a directory above
// it holds oats-local.yaml, else "work". Alias and address only: nothing
// secret is read.
export function awIdentity(env, aw) {
  const work = join(env.HOME, "Work");
  const dir = join(work, ".aw");
  if (!existsSync(dir)) return null;
  let role = "work";
  for (let d = work; d !== dirname(d); d = dirname(d)) if (discover.holdsLocalFile(d)) { role = "deployment-root"; break; }
  let who = {};
  if (aw) {
    const r = spawnSync(aw, ["whoami", "--json"], { cwd: work, env: awEnvironment(env), encoding: "utf8", timeout: 15_000 });
    try { if (r.status === 0) who = JSON.parse(r.stdout) || {}; } catch { /* no answer: alias and address unknown */ }
  }
  const text = (v) => (typeof v === "string" && v ? v : null);
  return { dir, alias: text(who.alias), address: text(who.address), role };
}

// `oats deployments --json` as listed, each with whether its `oats status
// --json` lists an instance of the steward's agent (false for a deployment
// that is not ok). → [{ dir, name, steward }]. An ok deployment whose status
// cannot be read throws, naming it: the onboarding agent trusts the list, so
// it never holds a steward: false nobody saw.
export async function deploymentsWithSteward(env, oats) {
  const list = listOf(await statusRead(oats, env, env.HOME, READ_TIMEOUT, undefined, ["deployments", "--json"]));
  if (!list.ok) throw new Error(list.reason);
  const out = [];
  for (const d of list.rows) {
    let steward = false;
    if (d.state === "ok") {
      const r = await statusRead(oats, env, d.path, READ_TIMEOUT, undefined, ["status", "--json"]);
      try {
        if (!r.ok) throw new Error(kernelMessage(r));
        steward = stewardsIn(r.stdout).length > 0;
      } catch (e) { throw new Error(`the deployment ${d.name} (${d.path}) could not be read: oats status --json: ${e.message}`); }
    }
    out.push({ dir: d.path, name: d.name, steward });
  }
  return out;
}

// The channel plugin for a Claude session in `dir`, from `claude plugin
// list --json`: "enabled", "disabled" or "absent". A user-scoped copy
// counts anywhere; a project or local one only for its own project, since
// the list also names other projects' copies.
export function channelState(listText, dir, id = CHANNEL) {
  let list;
  try { list = JSON.parse(listText); } catch { return "absent"; }
  if (!Array.isArray(list)) return "absent";
  const here = (p) => typeof p === "string" && resolve(p) === resolve(dir);
  const usable = list.filter((e) => e?.id === id && (e.scope === "user" || e.scope === "managed" || here(e.projectPath)));
  if (usable.some((e) => e.enabled === true)) return "enabled";
  return usable.length ? "disabled" : "absent";
}

function omarchyVersion(env) {
  const bin = which("omarchy-version", env.PATH);
  if (!bin) return null;
  const r = spawnSync(bin, [], { env, encoding: "utf8", timeout: 10_000 });
  return r.status === 0 ? (r.stdout.trim().split(/\s+/)[0] || null) : null;
}

export function pluginVersion() {
  return JSON.parse(readFileSync(join(PLUGIN_DIR, "manifest.json"), "utf8")).version;
}

// The found-list (docs/found-list.md), as an object.
export async function foundList({ env, harness, oats, aw, tools, now = new Date(), hostname = osHostname() }) {
  return {
    schemaVersion: FOUND_SCHEMA,
    writtenAt: now.toISOString(),
    machine: { hostname, platform: "omarchy", omarchyVersion: omarchyVersion(env) },
    harness,
    plugin: { dir: PLUGIN_DIR, version: pluginVersion() },
    gettingStartedSkill: gettingStartedSkill(oats),
    tools,
    awIdentity: awIdentity(env, aw),
    deployments: await deploymentsWithSteward(env, oats),
  };
}

// The onboarding prompt: lib/onboarding-prompt.txt with its placeholders
// filled. Facts only: the bootstrap's steps are getting-started's.
export function renderPrompt(values, template = readFileSync(PROMPT_FILE, "utf8")) {
  return template.replace(/\{\{(\w+)\}\}/g, (all, key) => {
    if (!(key in values)) throw new Error(`the onboarding prompt has an unknown placeholder ${all}`);
    return String(values[key]);
  }).trimEnd();
}

// Writes the found-list (atomically, 0600, under setup's state directory)
// and returns { path, prompt }.
export async function handoff({ env, harness, oats, aw, toolsText, now, hostname }) {
  if (!HARNESSES.includes(harness)) throw new Error(`--harness must be one of ${HARNESSES.join(", ")}`);
  if (!oats || !isAbsolute(oats)) throw new Error("--oats needs the OATS CLI's absolute path");
  const found = await foundList({ env, harness, oats, aw, tools: parseTools(toolsText), now, hostname });
  const dir = discover.paths(env).stateDir;
  makeDirs(dir);
  const path = join(dir, FOUND_FILE);
  atomicWrite(path, Buffer.from(`${JSON.stringify(found, null, 2)}\n`), 0o600);
  const prompt = renderPrompt({
    skill: found.gettingStartedSkill, hostname: found.machine.hostname, harness,
    pluginDir: found.plugin.dir, pluginVersion: found.plugin.version, foundList: path,
  });
  return { path, prompt };
}
