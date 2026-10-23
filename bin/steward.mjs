#!/usr/bin/env node
// setup's steward lookup (lib/setup.mjs lookUpSteward), in a node of its own,
// since findSteward is asynchronous and setup is not. The request is the JSON
// in OATS_OMARCHY_STEWARD: { shim, features, deployment, budgetMs }. It
// prints findSteward's answer as JSON. At the budget it prints that there
// was no answer and stops itself with SIGTERM, on which findSteward's kernel
// read kills its process group (lib/waiting.mjs statusRead), so no kernel is
// left running.
import { findSteward } from "../lib/steward.mjs";

const request = process.env.OATS_OMARCHY_STEWARD;
if (!request) {
  process.stderr.write("steward.mjs: setup runs it, with its request in OATS_OMARCHY_STEWARD\n");
  process.exit(2);
}
const { shim, features, deployment, budgetMs } = JSON.parse(request);
delete process.env.OATS_OMARCHY_STEWARD;
setTimeout(() => {
  process.stdout.write(JSON.stringify({ ok: false, reason: `no answer within ${budgetMs / 1000} s` }));
  process.kill(process.pid, "SIGTERM");
}, budgetMs);
process.stdout.write(JSON.stringify(await findSteward(process.env, { shim, features, deployment: deployment ?? undefined })));
process.exit(0);
