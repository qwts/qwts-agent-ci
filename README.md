# qwts-agent-ci

Shared CI for the `qwts` fleet: the composite actions every governed repository pins by commit SHA, the runtime-policy checker and pin-reachability guard behind them, and the reference documents the actions implement. Extracted from [qwts/agent-sop](https://github.com/qwts/agent-sop) at commit [`ed5c5d8`](https://github.com/qwts/agent-sop/commit/ed5c5d8f7aadba6eefa41a7fd17b076601530848) under the fleet split in [qwts/agent-sop#371](https://github.com/qwts/agent-sop/issues/371) and [qwts/agent-sop#372](https://github.com/qwts/agent-sop/issues/372): agent-sop keeps the rules, procedures, and guides, and each capability lives in its own repository, consumed by SHA-pinned reference.

## Actions

| Action | Purpose |
| --- | --- |
| [`ci-policy`](.github/actions/ci-policy/action.yml) | Authorize governed runtime actors, refuse public forks and drafts, and classify the run into the `full`, `queue`, `post-merge`, or `manual` lane with its release-projection outputs. |
| [`bounded-command`](.github/actions/bounded-command/action.yml) | Run one explicit command with a per-attempt deadline, finite retries, and process-tree cleanup. |
| [`bounded-dependency-install`](.github/actions/bounded-dependency-install/action.yml) | Restore a lockfile-bound download cache, run a bounded installer, and save a verified cache only from default-branch pushes. |
| [`changeset-release-count`](.github/actions/changeset-release-count/action.yml) | Report the semantic pending-release count from `changeset status` without counting governance-only changeset files. |
| [`ci-runtime-check`](.github/actions/ci-runtime-check/action.yml) | Reject runner jobs without a literal timeout and raw unbounded dependency installers. |

Consume an action by full commit SHA, never by tag or branch:

```yaml
uses: qwts/qwts-agent-ci/.github/actions/<name>@<sha>
```

The SHA the fleet is on is recorded once, as the `ci` capability in `org.json` in [qwts/qwts-agent-org](https://github.com/qwts/qwts-agent-org); consumers take their pin from there. `ci-policy` reads two data files from its own checkout at that SHA: `governance/release-lifecycles.json`, the reviewed release-lifecycle catalog (a repository that runs the action in classification mode must appear in it exactly once), and `governance/agents.json`, the agent App roster it authorizes runtime actors from, which is a copy of the org roster in qwts-agent-org and must be kept in step with it.

## Documents

- [CI execution policy](docs/ci-execution-policy.md) — the event-to-gate contract: runtime actor boundary, pull-request lifecycle, workflow contract, release projections, and required repository settings.
- [CI runtime budgets](docs/ci-runtime-policy.md) — whole-job backstops, the bounded external-setup deadline, envelope arithmetic, and fan-out backpressure.
- [Governed CI rollout checklist](docs/governed-ci-rollout.md) — inventory, workflow contracts, required-check publishers, privileged credentials, and manual settings for adopting the policy.
- [Release-lifecycle fleet handoff](docs/governed-ci-release-lifecycle-fleet.md) — where each governed repository stands against the release-lifecycle policy, and the repair handoff for Changesets repositories.
- [AGENTS.md](AGENTS.md) — agent context for working in this repository.

## Tests and checks

```sh
npm ci
npm test                  # node --test over every test file under tools/
npm run ci-runtime:check  # runtime policy against this repository's own workflows
npm run lint:markdown     # markdownlint docs/ AGENTS.md README.md
npm run pins:check        # first-party pin reachability; needs GH_DRIFT_TOKEN or gh auth
```

The actions and tools have zero runtime dependencies and use only Node's standard library; `markdownlint-cli` is the sole dev dependency. The documents are gated by docs-gov with the configuration in `docs-gov.config.json`, and every document must be linked from this file.

## Decisions stay in agent-sop

The ENG records that govern this code are not copied here. They remain in agent-sop and are amended there:

- [ENG-0004: Centralize shared CI/CD](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0004-centralize-shared-cicd.md) — shared CI/CD is reusable workflows and composite actions consumed by pinned reference, with zero runtime dependencies for the tooling.
- [ENG-0269: Reuse immutable dependency downloads on standard hosted runners](https://github.com/qwts/agent-sop/blob/main/docs/decisions/ENG-0269-trusted-dependency-reuse.md) — the trusted-cache custody and enclosure rules `bounded-dependency-install` implements.
