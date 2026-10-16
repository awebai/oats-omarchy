#!/usr/bin/env node
// oats omarchy: the package's one executable. The kernel dispatches
// `oats omarchy <command>` here as `bin/oats-omarchy.mjs <command> [args]`.
//
// This is the skeleton: it answers --help and refuses everything else with
// exit 2 (bad arguments) until the commands land.

const USAGE = `usage: oats omarchy <command>

commands:
  setup     make the OATS TUI and OATS Desktop Omarchy apps (not implemented yet)
  waiting   list the agents waiting on you in Omarchy's menu (not implemented yet)
`;

const args = process.argv.slice(2);

if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

process.stderr.write(`oats-omarchy: ${args.length ? `not implemented: ${args.join(" ")}` : "missing command"}\n${USAGE}`);
process.exit(2);
