# Archived: evidence from the pre-delegation architecture

These files were produced by the earlier design, where the "coordinator" was a
single-call router and all governance (retry loops, escalation, reporting) was
imperative harness code. That design did not meet the Stage 5 requirement that
the coordinator be a tool-using LLM whose reasoning governs the workflow, so
this material is NOT evidence for the current system. It is kept for history only.

Known problems with this evidence, recorded so nobody cites it by mistake:
- integration-test-results.json expected `ESCALATED` / `HIGH` for scenarios
  named "benign", i.e. expectations were tuned to match observed model output.
- The reports contain duplicated H1 and section headings, because headings
  passed through the LLM instead of being assembled by the harness.
- Costs omit the Report Writer step.
