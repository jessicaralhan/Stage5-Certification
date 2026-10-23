# Guardrails — what each one catches and why

This workflow has four layers of guardrail, each catching a different
class of problem. None of them ask an AI "is this okay?" and take its word
for it alone. All four run **live, inside `workflow/workflow.js`, between
steps** — not just inside a standalone `.test.yaml` eval — see
`workflow/workflow-definition.md`'s diagram for exactly where each one
sits, and `guardrails/guardrail-bypass-evidence.md` for real, executed
proof each one actually rejects bad input (not just that the code exists).

## 1. `schema-validation.js` — deterministic, catches malformed handoffs

Runs immediately after every agent call, before the next agent ever sees
the output. Checks: are the required fields present, are they the right
type, is `severity`/`verdict` one of the allowed enum values, is
`proposed_fix` non-trivial and free of `[TODO]`/`[TBD]`. This is plain code
— it cannot be talked out of its answer, and it has no opinion about
whether the *content* is good, only whether the *shape* is safe to hand to
the next step. If Agent 1 hallucinates malformed JSON, this stops it here
rather than letting Agent 2 try to make sense of garbage.

## 2. `concreteness-check.js` — deterministic, catches vague-but-well-formed content

Runs immediately after Agent 2's output passes schema-validation, before
Agent 3 ever sees it (`validateAgent2Concreteness` in `workflow.js`).
Schema-validation only checks *shape*; it would happily pass a
well-formed, non-placeholder `proposed_fix` that says nothing more useful
than "review before applying." This guardrail requires an objective marker
of concreteness instead — literal Terraform syntax (including a plain
`identifier = value` attribute assignment), a named AWS CLI/API call, a
literal CIDR, or a structured numbered plan — and blocks the handoff with
`FAILED_GUARDRAIL` if none is present. Previously this only ran inside
`agent2-stage3.test.yaml`'s standalone eval and never executed during a
real workflow run; now it's wired into the live pipeline, and the first
time it ran on real traffic it caught a real false-negative in its own
regex (a valid `force_destroy = false` assignment) — see `iteration.log`
for the fix.

## 3. `risk-check.js` — deterministic, catches specific dangerous patterns

Two hard-coded checks: `hasProductionDestructiveChange` and
`hasCriticalOrHighSecurityExposure`. These exist independently of any
agent's judgment and are what `punch-out/risk-gate.js`'s hard override
relies on — proven in `punch-out/bypass-test.js` Test 2, where a
(simulated) fooled Agent 3 verdict of `APPROVE` still gets overridden by
this check.

## 4. Agent 3 (Adversarial Reviewer) — reasoning-based, catches what code can't

The two deterministic guardrails above can only check *shape* and a small
set of *known* dangerous patterns. Neither can tell you whether a
remediation that looks fine actually achieves its stated goal. Agent 3's
job is specifically to challenge that: does this fix actually resolve the
issue, all the way through, or does it just relocate/hide the problem? See
`agent3.test.yaml`'s "SUBTLE FLAW" test for the concrete proof — a fix that
is well-formed JSON, uses a real Terraform mechanism, and would pass both
deterministic guardrails without complaint, but which Agent 3 correctly
identifies as silently defeating its own purpose.

## Why multiple layers, not just one

Deterministic checks are fast, free, and can't be fooled by clever
phrasing — but they can only catch what they were explicitly written to
catch, and as `guardrail-bypass-evidence.md` shows, they can themselves
have bugs (a crash on malformed input, a regex false-negative) that only
surface once they actually run on real traffic. An adversarial LLM
reviewer can catch novel, unanticipated problems — but it can also be
wrong, and its confidence isn't proof. Layering all four means a
genuinely dangerous or genuinely vague change has to get past every
deterministic check *and* a skeptical review to proceed, and even then,
production-destructive changes never proceed without a human (see
`punch-out/`).
