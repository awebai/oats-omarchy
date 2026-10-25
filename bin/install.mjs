#!/usr/bin/env node
// The node half of `omarchy-install-oats` (lib/install.mjs), which the sh
// installer runs once node is there:
//   install.mjs steward --oats <cli>                 --check's steward line; exit 0 when found
//   install.mjs channel --dir <dir>                  the aweb channel plugin for a Claude session
//                                                    in <dir> (`claude plugin list --json` on
//                                                    stdin): enabled, disabled or absent
//   install.mjs handoff --harness <h> --oats <cli> [--aw <aw>] [--github-login <login>
//                       --github-scopes <a,b>] [--agent-key moved|<why not>]
//                                                    writes the found-list (tools on stdin)
//                                                    and prints the onboarding prompt
//   install.mjs agent-key                            oats when the agent key opens OATS, else omarchy
//   install.mjs agent-key-result                     setup --json's answer (stdin) → moved, or why not
import { readFileSync } from "node:fs";
import { agentKeyMoved, agentKeyResult, channelState, handoff, stewardLine } from "../lib/install.mjs";

const [command, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!["--oats", "--harness", "--aw", "--dir", "--github-login", "--github-scopes", "--agent-key"].includes(rest[i]) || rest[i + 1] === undefined) {
    process.stderr.write(`install.mjs: unknown argument: ${rest[i]}\n`);
    process.exit(2);
  }
  flags[rest[i].slice(2)] = rest[i + 1];
}
try {
  if (command === "steward") {
    const r = await stewardLine(process.env, flags.oats);
    process.stdout.write(`${r.line}\n`);
    process.exit(r.ok ? 0 : 1);
  } else if (command === "channel" && flags.dir) {
    process.stdout.write(`${channelState(readFileSync(0, "utf8"), flags.dir)}\n`);
    process.exit(0);
  } else if (command === "handoff") {
    const r = await handoff({
      env: process.env, harness: flags.harness, oats: flags.oats, aw: flags.aw || null, toolsText: readFileSync(0, "utf8"),
      githubLogin: flags["github-login"], githubScopes: flags["github-scopes"], agentKey: flags["agent-key"],
    });
    process.stdout.write(r.prompt);
    process.exit(0);
  } else if (command === "agent-key") {
    process.stdout.write(`${agentKeyMoved(process.env) ? "oats" : "omarchy"}\n`);
    process.exit(0);
  } else if (command === "agent-key-result") {
    process.stdout.write(`${agentKeyResult(readFileSync(0, "utf8"))}\n`);
    process.exit(0);
  }
  process.stderr.write("usage: install.mjs steward --oats <cli> | channel --dir <dir> | handoff --harness <h> --oats <cli> [--aw <aw>] [...] | agent-key | agent-key-result\n");
  process.exit(2);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
