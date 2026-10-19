#!/usr/bin/env node
// The oats menu's "Status" row with this computer's list of deployments:
// `<node> bin/status.mjs` in the floating terminal.
import { statusEvery } from "../lib/waiting.mjs";

statusEvery().then((code) => process.exit(code));
