#!/usr/bin/env node
// The engine of the plugin's `setup` command. The `setup` launcher at the
// plugin's root runs it with node, and the post-update hook runs it with the
// node setup recorded.
import { setup, USAGE } from "../lib/setup.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
process.exit(setup(args));
