# AGENTS.md

Canonical, vendor-neutral agent context for this repository, per
[ENG-0006](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0006-agentic-primitives-governance.md).
Vendor-specific files (Copilot instructions, Cursor rules, and similar) are
thin adapters onto this file — they never restate what is here.

<!-- governed:shared-agent-discovery:start -->

## Shared agent conventions and skills

PR-first workflow, validation-before-push, commit and PR hygiene, and the
untrusted-input threat model are defined once, for every repo, in the
[org-wide agent conventions](https://github.com/qwts/agent-sop/blob/main/docs/reference/agent-conventions.md).
Before creating or copying a repo-local skill, consult the reviewed
[shared agent skills](https://github.com/qwts/agent-sop/blob/74e775ef23d8e7d8f8e693ccc2329f430978c096/skills/README.md)
index. Reuse only the pinned version supplied by the governed harness; a skill
genuinely specific to this repository belongs in its local context.
This repository is governed by
[agent-sop](https://github.com/qwts/agent-sop) — its
[shared SOPs](https://github.com/qwts/agent-sop/blob/main/docs/sop/README.md)
and [engineering decisions](https://github.com/qwts/agent-sop/blob/main/docs/decisions/README.md)
apply here by default
([ENG-0008](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0008-shared-sop-inheritance.md):
inherit by default, vary by explicit delta).
<!-- governed:shared-agent-discovery:end -->

## What is specific to this repository

- **What it is:** the fleet's shared CI actions, the runtime-policy checker, the pin-reachability guard, and the CI reference documents, extracted from agent-sop under [qwts/agent-sop#371](https://github.com/qwts/agent-sop/issues/371) and [qwts/agent-sop#372](https://github.com/qwts/agent-sop/issues/372). Map: [README.md](README.md).
- **Consumption is by commit SHA.** Consumers write `uses: qwts/qwts-agent-ci/.github/actions/<name>@<40-hex sha>`, and the fleet pin is the `ci` capability in qwts-agent-org's `org.json`. Merging a change here moves no consumer; pins advance deliberately.
- **Zero runtime dependencies** ([ENG-0004](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0004-centralize-shared-cicd.md)): actions and tools use Node's standard library only; `markdownlint-cli` is the sole dev dependency.
- **Validate before opening or updating a PR:** `npm test`, `npm run ci-runtime:check`, `npm run lint:markdown`, and the docs-gov gate (configuration in `docs-gov.config.json`; the tooling lives in the docs-gov capability repository). CI runs the first three on hosted runners.
- **Docs and data travel with the code.** `tools/ci-policy/tests/governed-ci-docs.test.mjs` asserts that the actions and `docs/` agree; `governance/release-lifecycles.json` must list every repository that runs `ci-policy` in classification mode exactly once; `governance/agents.json` is a copy of the org roster and must be kept in step with it. A new document must be linked from [README.md](README.md) or docs-gov's `orphan-doc` rule fails it.
- **Decisions stay in agent-sop.** The ENG records governing this code (ENG-0004, ENG-0267, ENG-0269, ENG-0313) are amended there, never copied here.
