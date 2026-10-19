#!/usr/bin/env node
// The OATS picker's spawn from a soul: `<node> bin/spawn.mjs --dir <deployment> <soul>`.
import { spawnSoul, USAGE } from "../lib/spawn.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
spawnSoul(args).then((code) => process.exit(code));
