# Guardrail Bypass Test Evidence

## What this proves

`punch-out/punch-out-test-evidence.md` proves the Risk Gate's hard override
can't be bypassed. This file proves the same thing one layer earlier: that
the two deterministic **guardrails** (`schema-validation.js` and
`concreteness-check.js`) actually reject bad handoffs, not just that the
code exists. Every real workflow run on disk happens to have `valid: true`
on every guardrail check — which is architecturally reassuring but never
actually observed the blocking path firing. This test forces it to fire.

## How to reproduce

```bash
cd stage4-certification
node guardrails/guardrail-bypass-test.js
```

## Actual output (real run, not hand-typed — captured directly from the command above)

```
=== Test 1: Agent 1 hallucinated/malformed JSON is rejected ===
[PASS] schema-validation rejects a non-array destructive_changes field
[PASS] schema-validation rejects an invalid risk_level enum value
  errors: ["missing or non-array field: destructive_changes","missing or non-array field: security_exposure","invalid risk_level: SUPER_BAD"]

=== Test 2: Agent 2 placeholder/[TODO] output is rejected by schema-validation ===
[PASS] schema-validation rejects a [TODO] placeholder proposed_fix
  errors: ["remediations[0] contains placeholder text"]

=== Test 3: Agent 2 vague-but-well-formed output is rejected by concreteness-check ===
  (This is the case schema-validation alone CANNOT catch — the JSON is well-formed,
  long enough, and has no [TODO] marker, but contains no objective technical content.)
[PASS] schema-validation alone WOULD have let this through (proves concreteness-check is not redundant)
[PASS] concreteness-check correctly rejects it as non-concrete
  fix text: "Please be careful and review this change thoroughly before applying it to make sure everything is okay and nothing breaks in production."

=== Test 4: Agent 2 genuinely concrete output is correctly accepted ===
[PASS] concreteness-check correctly accepts real Terraform + AWS CLI content
  fix text: "Apply lifecycle { create_before_destroy = true } and run `aws rds describe-db-instances --db-instance-identifier orders-prod-db` to confirm the new instance is healthy before removing the old one."

=== Test 5: Agent 3 invalid verdict enum is rejected ===
[PASS] schema-validation rejects a verdict outside APPROVE|REVISE|ESCALATE
  errors: ["invalid verdict: LOOKS_FINE_I_GUESS"]

=== Test 6: well-formed, concrete, valid-verdict output passes every guardrail ===
[PASS] valid Agent 1 output passes
[PASS] valid + concrete Agent 2 output passes both guardrails
[PASS] valid Agent 3 output passes
```

## A real bug this test found (not a clean first pass)

The first time this was run, Test 1 crashed instead of printing `[FAIL]`:

```
TypeError: (json.destructive_changes || []).forEach is not a function
    at validateAgent1Output (guardrails/schema-validation.js:16:36)
```

`json.destructive_changes` was set to a hallucinated string
(`"not-an-array"`), which is truthy, so `|| []` never kicked in and
`.forEach` was called on a string. A guardrail that throws an uncaught
exception on malformed input is a worse failure than the thing it's
supposed to catch — it would have crashed `workflow.js` entirely instead
of producing a clean `FAILED_GUARDRAIL` result. Fixed in
`guardrails/schema-validation.js` by guarding both array walks with
`Array.isArray()` instead of the `|| []` fallback. The output above is
from the run *after* that fix.

## A second real bug this test found, once wired into a live run

Once `concreteness-check.js` was actually wired into `workflow.js` between
Agent 2 and Agent 3 (see `workflow/workflow-definition.md`), the very first
live scenario to exercise it (`eval_run_scenario7`) produced a genuinely
concrete fix — `force_destroy = false`, a plain Terraform attribute
assignment — that the guardrail incorrectly rejected, because
`isConcreteFix`'s Terraform-syntax check only recognized a fixed keyword
list, not the general `identifier = value` HCL shape. This is exactly the
kind of false negative that only surfaces once a guardrail sees real
traffic instead of a fixed test set — see `iteration.log` for the full
writeup and the fix.

## What this does and doesn't prove

- **Proves:** both deterministic guardrails reject the specific classes of
  bad input they're designed to catch, on demand, every time (deterministic
  — same input, same output).
- **Proves:** `concreteness-check.js` is not redundant with
  `schema-validation.js` — Test 3 shows an input that passes schema
  validation (well-formed JSON, no placeholder, long enough) but is
  correctly caught by concreteness-check alone.
- **Does not prove:** that a real agent will ever *produce* this kind of
  malformed or vague output in practice — Agent 1/2/3 have not been
  observed doing so across any of the 16 real workflow runs in `runs/`.
  This test proves the safety net exists and works if they ever do, the
  same way `punch-out/bypass-test.js` proves the risk gate's override
  works if Agent 3 is ever wrong, without requiring an agent to actually
  be wrong on demand.
