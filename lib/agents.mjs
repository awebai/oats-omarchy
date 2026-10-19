// `bin/agents.mjs --json`: the OATS picker's read. Every agent instance and
// every soul of one deployment (--dir) or of every deployment in this
// computer's list (--list), as one JSON answer that the picker shows and
// derives nothing from but its layout. The kernel is reached through the shim
// setup wrote, and read through lib/read.mjs, as `waiting` reads it.
//
// Each contract is used only when the kernel's `oats version --json` lists
// it: `waiting-on-you` (an instance's `waitingOnYou`; without it the answer
// says the CLI does not report it, and no claim is read) and
// `launch-preference` (the roster's agent `key`, by which a soul counts its
// instances; without it there is no count). The souls answer must be
// `soulsApi: 1`, or that deployment's souls are unknown on their own.
import * as discover from "./discover.mjs";
import { emptyAnswer, firstLine, kernelError, kernelRead, readEvery, shimOf, STATUS_OUTPUT_LIMIT } from "./read.mjs";

export const USAGE = `usage: agents (--dir <deployment> | --list) --json

  Prints, for the OATS picker, every agent instance and every soul of the
  deployment (--dir) or of every deployment in this computer's list (--list,
  \`oats deployments\`), read one after another:
  {ok, features: {waitingOnYou, soulCounts}, deployments: [{path,
  name, workspace, ok, reason?, agents: [{agent, instance, home, running,
  waitingOnYou}], souls: [{key, name, description, spawnable, problem,
  instances}] | null, soulsReason?}], note?}, or {ok: false, reason}. ok is
  false only when no deployment could be read.
`;

export const WAITING_FEATURE = "waiting-on-you";
export const COUNT_FEATURE = "launch-preference";
// As `waiting --list`: each read within 25 s, all of them within 110 s, so
// the answer comes before the picker's deadline (120 s).
export const PER_READ = 25_000;
export const BUDGET = 110_000;

export function parseArgs(argv) {
  let dir = null;
  let list = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") { json = true; continue; }
    if (argv[i] === "--list") { list = true; continue; }
    if (argv[i] === "--dir") { dir = argv[++i]; if (!dir) return { error: "--dir needs a value" }; continue; }
    if (argv[i].startsWith("--dir=")) { dir = argv[i].slice("--dir=".length); if (!dir) return { error: "--dir needs a value" }; continue; }
    return { error: `unknown argument: ${argv[i]}` };
  }
  if (!json) return { error: "agents prints JSON only: pass --json" };
  if (list === (dir !== null)) return { error: "pass --dir <deployment> or --list, one of them" };
  return { dir, list };
}

// The kernel's features, from `oats version --json`. → { ok, features } |
// { ok: false, reason }.
function featuresOf(r) {
  if (!r.ok) return { ok: false, reason: kernelError(r) };
  try {
    const features = JSON.parse(r.stdout).features;
    return Array.isArray(features) ? { ok: true, features } : { ok: false, reason: "it lists no features" };
  } catch { return { ok: false, reason: "it printed no JSON" }; }
}

// readEvery's answer → the picker's: the instances (without their claims
// when the kernel does not report them), the souls, or why not.
export function answer(every, { waitingOnYou, soulCounts }) {
  if (!every.ok) return { ok: false, reason: firstLine(every.reason) };
  const features = { waitingOnYou, soulCounts };
  const shown = every.deployments.map((d) => {
    if (!d.ok) return d;
    const { agents, ...rest } = d;
    const instances = agents.flatMap((a) => a.instances).map((row) => (waitingOnYou ? row : { ...row, waitingOnYou: null }));
    return { ...rest, agents: instances };
  });
  const empty = emptyAnswer(every);
  if (empty && !empty.ok) return empty;
  return { ok: true, features, deployments: shown, ...(empty ? { note: empty.note } : {}) };
}

// `perReadMs`, `budgetMs` and `outputLimit` are for tests. → a promise of
// the exit code.
export async function agents(argv, env = process.env, err = process.stderr, { out = process.stdout, perReadMs = PER_READ, budgetMs = BUDGET, outputLimit = STATUS_OUTPUT_LIMIT } = {}) {
  const args = parseArgs(argv);
  if (args.error) { err.write(`agents: ${args.error}\n${USAGE}`); return 2; }
  const print = (result) => { out.write(`${JSON.stringify(result)}\n`); return result.ok ? 0 : 1; };
  const prep = shimOf(env);
  if (!prep.ok) return print({ ok: false, reason: firstLine(prep.reason) });
  let dir = null;
  if (!args.list) {
    const dep = discover.deployment({ dir: args.dir });
    if (!dep.ok) return print({ ok: false, reason: firstLine(dep.reason) });
    dir = dep.path;
  }
  const start = Date.now();
  const read = (a, cwd, ms) => kernelRead(prep.shim, env, cwd, ms, outputLimit, a);
  const version = featuresOf(await read(["version", "--json"], dir ?? env.HOME, Math.min(perReadMs, budgetMs)));
  if (!version.ok) return print({ ok: false, reason: firstLine(`oats version --json: ${version.reason}`) });
  const has = (f) => version.features.includes(f);
  const counts = has(COUNT_FEATURE);
  const every = await readEvery(read, env.HOME, { perReadMs, budgetMs: budgetMs - (Date.now() - start), dir, souls: true, counts });
  return print(answer(every, { waitingOnYou: has(WAITING_FEATURE), soulCounts: counts }));
}
