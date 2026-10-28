# Stage 5: Infrastructure Review Delegation System

A **dispatch-only coordinator LLM** governs three workflow sub-agents (Terraform, Kubernetes, IAM), one cross-workflow **adversarial reviewer** that runs in its own context and can read the source file, and a **final review writer**. The coordinator holds only `launch_*` tools. It never reads the input file. The harness enforces structure; the LLM decides what to do.

Critical question for Stage 5: when an AI system coordinates other AI systems, how do you keep it governing instead of becoming a mega-agent? Answer in this repo: the coordinator's tool list is declared in a manifest, built from it at runtime, refused at startup if it holds anything but `launch_*` tools, and tested.

## How it works

```
input file (name, extension, size only) ──► Coordinator LLM  (tools: launch_* only)
                                                │  reasons over validated results, decides next dispatch
        ┌───────────────┬───────────────┬───────┴────────┬─────────────────────┬──────────────────────┐
launch_terraform   launch_kubernetes   launch_iam   launch_adversarial   launch_final_review
_workflow          _workflow           _workflow    _reviewer            _writer
(analyze|remediate)(analyze|remediate) (…)          (fresh context,      (prose only)
                                                    read_file jailed
                                                    to the input file)
        └───────── every output schema-validated BEFORE the coordinator sees it ─────────┘
                                                │
                              deterministic hard gates (coordinator cannot approve past them)
                                                │
                       report assembled by code: headings + PASS/FAIL never pass through an LLM
                                                │
                  PENDING_HUMAN_DECISION ──► append-only human ledger (Continue / Reject, named reviewer)
```

What the **LLM decides** (`prompts/coordinator-agent.md`): which workflow to launch, whether to remediate, when to review, whether to re-invoke a sub-agent with reviewer challenges and which artifact to target, when the loop has settled, and whether to approve or escalate. There is no `while (REVISE)` loop in the harness.

What the **code enforces** (`workflow/`): the tool surface, schema validation of every sub-agent output, dispatch and revision budgets, input-type checks, the hard gates, substance elevation, deterministic report structure, and the audit trail.

## Stage 5 requirements and where to verify them

| Requirement | Implementation | Proof (run `npm test`) |
|---|---|---|
| Dispatch-only coordinator, one tool per sub-agent | `agents.manifest.json` `coordinator.tools` (5 `launch_*` tools); `workflow/coordinator.js` `assertDispatchOnly`, `buildCoordinatorTools` | `tests/dispatch-only.test.js`: tool names, startup refusal of `read_file`/`bash`/`http_get`, API request tools equal the manifest, the coordinator never receives file contents (including an injected "approve this" line), a forged tool call is blocked and audited |
| Tools can target a specific step | each workflow tool takes `step: analyze \| remediate` and `challenges` | `tests/governance.test.js` (re-invocation with challenges) |
| Governance is in LLM reasoning | `prompts/coordinator-agent.md`, tool-use loop in `workflow/coordinator.js` | `tests/governance.test.js` drives the loop with a scripted policy; no revision loop exists in code |
| Sub-agents scoped to one workflow | per-agent `tools` and `scope` in the manifest; workflow sub-agents hold no tools | `tests/dispatch-only.test.js` |
| Stage 3 guarantees per workflow | prompt + at least 3 named criteria + measured results for 5 agents, `evals/definitions.js` | `tests/evals.test.js` proves every criterion passes on good and fails on bad output. **Measured results:** `npm run eval` writes `evals/results/*.results.json` (see "Evidence you must generate") |
| Adversarial review in its own context | `workflow/subagents.js` `runAdversarialReviewer`: new empty message list per review, `isolated_context` recorded | `tests/reviewer-isolation.test.js` |
| Reviewer has `read_file` and verifies claims | path-jailed `read_file`; reviewer rejected if it never reads the file; file-quoted evidence checked against the file | `tests/reviewer-isolation.test.js` |
| Final review writer is its own workflow | `prompts/final-review-writer.md`; refused unless every executed workflow has a current review | `tests/governance.test.js` |
| Deterministic headings, PASS/FAIL from findings | `workflow/report.js`, `workflow/gates.js` `workflowStatus`; LLM headings are demoted to bold | `tests/governance.test.js`, `tests/schema-guardrails.test.js` |
| Schema validation before the coordinator sees output | `workflow/schemas.js`; failures return `{ok:false, error:{code, retryable, details}}` | `tests/schema-guardrails.test.js` |
| Custom harness, no CLI shells at runtime | direct HTTPS client `workflow/anthropic-client.js` | `tests/no-cli-runtime.test.js` |
| Punch-outs honored, no auto-approve | `workflow/gates.js`; a coordinator `APPROVE` is overridden and recorded | `tests/human-gate.test.js` |
| Substance assessment, elevation, append-only human override | `substance.json`, `evaluateSubstance`, `punch-out/decisions.js`, `punch-out/human-decision-cli.js` | `tests/substance.test.js`, `tests/human-gate.test.js` |
| Audit trail with correlation ID, persisted to disk | `workflow/audit.js` writes `results/<id>/audit.jsonl` per event | `tests/audit.test.js` (including a crash mid-run) |
| Version-controlled repo with meaningful history | git history; `GIT-LOG.txt` via `npm run export:gitlog` | n/a |

## Substance assessment (`substance.json`)

Scored for relevance to an IT consultant's real work, not by whether a run produced findings:

| Workflow | Category | Why |
|---|---|---|
| Terraform review | core | pre-apply change-risk review is billable cloud governance work |
| Kubernetes review | core | standard paid platform-security assessment |
| IAM audit | core | least-privilege audit is a common paid deliverable |
| Final review writer | peripheral | required for delivery, but not bought on its own |

Rule: any toy, or two or more peripheral, elevates for human review and blocks final disposition until a human records Continue or Reject. This system has one peripheral and no toy, so it does not elevate by itself; `tests/substance.test.js` shows the elevation path working.

## Run it

```bash
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY; never commit .env
npm test                    # 46 offline tests, no API key needed

# one examination
node workflow/coordinator-harness.js test-data/terraform-destructive.tf production

# decide a pending run (named reviewer required)
npm run decide -- list
npm run decide -- decide <correlation_id> --decision continue --reviewer "Your Name" --notes "..."
npm run decide -- status <correlation_id>
```

Each examination writes `results/<correlation_id>/`: `report.md` (system report, retained verbatim), `run.json` (artifacts, gates, disposition, final status), `audit.jsonl` (every model call: agent, step, model requested and reported by the API, input and output tokens, cost), and `decisions.jsonl` once a human decides.

Final statuses: `APPROVED`, `PENDING_HUMAN_DECISION` (any gate, substance elevation, coordinator escalation, or an incomplete examination; fail closed), then `HUMAN_CONTINUE` or `HUMAN_REJECTED` once a human records a decision.

## Evidence you must generate (needs an API key)

Offline tests prove the guarantees. Measured model behavior can only come from live runs, and no results are hand-written. Before submitting:

```bash
npm run eval                                   # writes evals/results/<agent>.results.json, audit/, SUMMARY.md
node workflow/coordinator-harness.js test-data/terraform-destructive.tf production
node workflow/coordinator-harness.js test-data/k8s-rbac-overly-permissive.yaml production
node workflow/coordinator-harness.js test-data/iam-overly-broad-policy.json production
node workflow/coordinator-harness.js test-data/iam-least-privilege.json non-production   # the clean path
npm run decide -- decide <one pending id> --decision continue --reviewer "Your Name"
npm run export:gitlog
git add evals/results results GIT-LOG.txt && git commit
```

If an eval criterion fails, fix the prompt or the criterion on its merits and re-run; record why in the commit message. Do not edit expectations to match output (the earlier "benign scenario expects ESCALATED" tests did exactly that).

## Known limitations

- Pricing rates in `workflow/config.js` are unverified against published pricing; every audit line says so.
- Each examination covers one input file. A multi-file examination would add per-file contexts.
- Substance categories are the author's declared assessment; a human reviewer can override via the decision ledger.
- Input-type detection is heuristic (`WORKFLOWS[*].accepts`); a mismatch returns `INPUT_TYPE_MISMATCH` before any model spend.

## History note

`archive/pre-delegation-architecture/` holds evidence from the earlier design, where the "coordinator" was a one-shot router and governance was harness code. It is kept for history and explained in its README. In that evidence all three stored runs show the workflow `FAILED`: a concreteness regex rejected valid HCL and YAML brackets, the failure fell closed to `ESCALATE`, and the old integration tests expected `ESCALATED` for every scenario, so crashes passed as results. The current design reports sub-agent errors separately (`sub_agent_errors` in `run.json`, "Sub-agent Errors" in the report) so a failure can never look like a finding.
