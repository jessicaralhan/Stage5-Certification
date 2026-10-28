# Stage 3 evals (one per agent)

Run: `npm run eval` (all) or `npm run eval:terraform | eval:kubernetes | eval:iam | eval:reviewer | eval:writer`.
Needs `ANTHROPIC_API_KEY`. Writes measured results to `evals/results/`:

- `<agent>.results.json`: per case, per named criterion: pass/fail and the reason
- `audit/<agent>-<timestamp>/audit.jsonl`: every model call with tokens and cost
- `SUMMARY.md`: one table across agents (written on a full run)

Every criterion is a deterministic check on real model output, so the same output always scores the same. `tests/evals.test.js` proves each criterion passes on good output and fails on bad output without an API key.

| Agent | Prompt(s) | Named criteria |
|---|---|---|
| terraform | `workflow1-terraform-analyzer.md`, `workflow1-terraform-generator.md` | flags-prod-destroy, rates-critical, names-forcing-attribute, no-false-destructive, no-false-public-exposure, flags-open-cidr, open-cidr-rated-high-or-critical, fix-gives-value-or-command, one-concrete-fix-per-finding, schema-valid, bare-json-output |
| kubernetes | `workflow2-kubernetes-analyzer.md`, `workflow2-kubernetes-generator.md` | detects-rbac-wildcard, names-the-role, risk-elevated, detects-privileged-pod, detects-multiple-issue-types, no-false-critical, one-concrete-fix-per-finding, schema-valid, bare-json-output |
| iam | `workflow3-iam-analyzer.md`, `workflow3-iam-generator.md` | detects-wildcard-permissions, rates-critical, fix-enumerates-actions, no-false-critical, one-concrete-fix-per-finding, schema-valid, bare-json-output |
| adversarial_reviewer | `adversarial-reviewer.md` | does-not-approve-flawed-fix, catches-self-defeating-fix, escalates-prod-replacement, catches-missed-finding, verifies-against-source-file, file-quotes-are-genuine, schema-valid |
| final_review_writer | `final-review-writer.md` | sections-complete, no-new-findings, writes-no-headings, does-not-soften-failure |

Target: 95% of checks per agent (`--min-pass-rate`, default 0.95; the runner exits non-zero below it).

Notes on what the criteria deliberately measure:

- `bare-json-output` checks that the model obeyed "JSON only, no fences". The runtime tolerates fenced JSON (and records it); the eval does not, so the instruction is enforced where it is measured.
- `no-false-*` criteria guard against a system that escalates everything. The clean fixtures must not be flagged CRITICAL or invented findings.
- The reviewer and writer evals run on fixed artifacts, so they are measured separately from the agents that produce those artifacts.
