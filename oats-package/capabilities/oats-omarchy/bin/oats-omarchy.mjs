#!/usr/bin/env node
// oats omarchy: the package's one executable. The kernel dispatches
// `oats omarchy <command> [args]` here as `bin/oats-omarchy.mjs <command> [args]`.
import { setup, USAGE as SETUP_USAGE } from "../lib/setup.mjs";
import { waiting, USAGE as WAITING_USAGE } from "../lib/waiting.mjs";

const USAGE = `usage: oats omarchy <command>

commands:
  setup     make the OATS TUI and OATS Desktop Omarchy apps (--plan | --apply | --remove | --check)
  waiting   pick an agent waiting on you in Omarchy's menu and open its session
`;

const [command, ...rest] = process.argv.slice(2);

if ((command === "--help" || command === "-h") && !rest.length) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (command === "setup") {
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    process.stdout.write(SETUP_USAGE);
    process.exit(0);
  }
  process.exit(setup(rest));
}
if (command === "waiting") {
  if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
    process.stdout.write(WAITING_USAGE);
    process.exit(0);
  }
  process.exit(waiting(rest));
}

process.stderr.write(`oats-omarchy: ${command ? `unknown command: ${[command, ...rest].join(" ")}` : "missing command"}\n${USAGE}`);
process.exit(2);
