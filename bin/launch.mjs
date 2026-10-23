#!/usr/bin/env node
// `omarchy-launch-oats` (the POSIX sh launcher beside it runs this with the
// node setup recorded): this machine's steward in an agent window, and the
// window's own flow (--in-terminal). See lib/launch.mjs.
import { exit, launch, USAGE } from "../lib/launch.mjs";

const args = process.argv.slice(2);
if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
  process.stdout.write(USAGE);
  process.exit(0);
}
launch(args).then(exit);
