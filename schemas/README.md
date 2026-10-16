# Vendored kernel schemas

Byte-identical copies of the OATS kernel's manifest schemas, which
`scripts/validate-manifests.mjs` checks the payload against:

| File | Source |
|---|---|
| `capability-manifest.schema.json` | awebai/oats `docs/capability-manifest.schema.json` |
| `oats-package.schema.json` | awebai/oats `docs/oats-package.schema.json` |

Both are taken from tag `v0.60.0`, commit
`88f0626e5368e378e88731845fde9938813ef3ca`. To refresh them, copy both files
from one kernel commit and update the tag and commit here in the same change.
