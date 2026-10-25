// lib/agent-permissions.json is a vendored copy of the agent permission
// profile in oats.setup's `oats-agent-permissions` skill, pinned to the tag
// below: the skill's `autoMode` block (its section 2) and its `permissions`
// block (its section 3). Their content must stay the tag's, so a change is a
// deliberate re-vendor. The installer will write this profile for OATS
// launches once awebai/oats#1506 decides where (awebai/oats-omarchy#27);
// awebai/oats#1510 asks oats.framework to ship it as a file of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./helpers/sandbox.mjs";

const TAG = "oats-framework/v1.13.2";
const SKILL = "oats-package/capabilities/oats-setup/skills/oats-agent-permissions/SKILL.md";
// sha256 of JSON.stringify of each section, parsed from the skill's two
// ```json blocks at TAG.
const DIGEST = {
  autoMode: "66ba8b30023d2bb63c1fc7df1d993dfdd0e82842124c5f8038f8c5c61ee7927b",
  permissions: "ed49b55332f3ae877d5065485ca59469ec03fa03c102582bdb154c64aea59c11",
};

const REVENDOR = `lib/agent-permissions.json is vendored from awebai/oats ${SKILL}@${TAG}. To re-vendor it from a newer tag:
  1. at that tag, parse the skill's two \`\`\`json blocks: the first holds autoMode, the second permissions;
  2. write { autoMode, permissions } from them to lib/agent-permissions.json (JSON.stringify(profile, null, 2) and a newline);
  3. set TAG and DIGEST in this test (sha256 of JSON.stringify of each section).`;

test(`lib/agent-permissions.json is ${SKILL}@${TAG}'s profile, unchanged`, () => {
  const profile = JSON.parse(readFileSync(join(repo, "lib", "agent-permissions.json"), "utf8"));
  assert.deepEqual(Object.keys(profile), ["autoMode", "permissions"], REVENDOR);
  for (const [section, digest] of Object.entries(DIGEST)) {
    assert.equal(createHash("sha256").update(JSON.stringify(profile[section])).digest("hex"), digest, `its ${section} differs from ${TAG}.\n${REVENDOR}`);
  }
});
