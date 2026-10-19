// lib/stable-node.mjs is a vendored copy of the kernel's rule, pinned to the
// tag its header names. The code below the header must stay byte-identical
// to that tag's source, so a change to it is a deliberate re-vendor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo } from "./helpers/sandbox.mjs";

const TAG = "v0.60.0";
// sha256 of awebai/oats lib/stable-node.mjs at TAG, from its first line
// `import { realpathSync } from "node:fs";` up to (not including) the line
// `let kernel = null;`, trailing blank lines trimmed to one newline.
const DIGEST = "404c39fc557734ff2cb6830e77910c55a2af23dc6f00b9110117a603ea6eb2e1";

const REVENDOR = `lib/stable-node.mjs is vendored from awebai/oats lib/stable-node.mjs@${TAG}. To re-vendor it from a newer tag:
  1. at that tag, copy lib/stable-node.mjs from \`import { realpathSync } from "node:fs";\` up to (not including) \`let kernel = null;\` (stableNode and unitPathEntries; kernelNode is left out);
  2. put it below this file's header comment, ending in one newline, and name the new tag in the header;
  3. set TAG and DIGEST in this test (sha256sum of the copied code) and run the tests that use lib/discover.mjs.`;

test(`lib/stable-node.mjs is awebai/oats lib/stable-node.mjs@${TAG}, unchanged`, () => {
  const text = readFileSync(join(repo, "lib", "stable-node.mjs"), "utf8");
  const header = text.slice(0, text.indexOf("import "));
  assert.ok(header.includes(`awebai/oats lib/stable-node.mjs@${TAG}`), `the header names another tag.\n${REVENDOR}`);
  const code = text.slice(header.length);
  assert.equal(createHash("sha256").update(code).digest("hex"), DIGEST, `the vendored code differs from ${TAG}.\n${REVENDOR}`);
});
