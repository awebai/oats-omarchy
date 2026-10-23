Inputs for test/steward.test.mjs and test/launch.test.mjs, shaped like the
real OATS CLI 0.67.1 output: `oats deployments --json` (the envelope) and
`oats status --json`, captured read-only on a machine and trimmed. Every
field name is the kernel's. The paths, names and workspace key are made up,
each instance row keeps a subset of its fields, `features` is shortened, and
the oats-machine--steward agent is modelled on a package soul's agent from
that capture (its name as packageSoulAgentName gives it, with
soulSource.path oats-package/souls/<soul>).
