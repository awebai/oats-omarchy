#!/usr/bin/env node
// The OATS picker's read: `<node> bin/agents.mjs (--dir <deployment> | --list) --json`.
import { agents, USAGE } from "../lib/agents.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
agents(args).then((code) => process.exit(code));
