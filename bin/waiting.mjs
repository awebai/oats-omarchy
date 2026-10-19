#!/usr/bin/env node
// The oats menu's "Waiting on you" row: `<node> bin/waiting.mjs --dir <deployment>`.
import { waiting, USAGE } from "../lib/waiting.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
Promise.resolve(waiting(args)).then((code) => process.exit(code));
