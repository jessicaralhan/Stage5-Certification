// The Risk Gate: where automation deliberately stops. This is the punch-out
// mechanism, a decision this workflow refuses to let an AI make alone. It is
// plain, deterministic code, not a model call, and it does NOT trust Agent 3's
// verdict alone. Agent 3's own sign-off flags are enforced here too, because
// its prompt says to escalate on them and code is what makes that reliable.

const {
  hasProductionDestructiveChange,
  hasProductionCriticalOrHighSecurityExposure,
  hasCriticalOrHighSecurityExposure,
} = require("../guardrails/risk-check");

const MAX_REVISE_LOOPS = 2;

function reviewedItems(verdict) {
  return Array.isArray(verdict.reviewed_remediations) ? verdict.reviewed_remediations : [];
}

/**
 * @param {object} findings     Agent 1 output
 * @param {object} verdict      Agent 3 output ({verdict, verdict_reasoning, reviewed_remediations})
 * @param {number} reviseCount  REVISE loops already taken for this run
 * @param {string} environment  operator-supplied run environment ("production" | "non-production")
 * @returns {{decision: "APPROVED"|"REVISE"|"PUNCH_OUT", reason: string}}
 */
function evaluateRiskGate(findings, verdict, reviseCount = 0, environment) {
  // Hard override 1: production destructive change. Independent of the AI verdict.
  if (hasProductionDestructiveChange(findings, environment)) {
    return {
      decision: "PUNCH_OUT",
      reason:
        "Hard override: findings include a destructive/forces-replacement change on a production resource. " +
        "This decision is never left to the AI verdict alone, regardless of what Agent 3 concluded.",
    };
  }

  // Hard override 2: production CRITICAL/HIGH security exposure. Also independent of the verdict.
  if (hasProductionCriticalOrHighSecurityExposure(findings, environment)) {
    return {
      decision: "PUNCH_OUT",
      reason:
        "Hard override: CRITICAL/HIGH security exposure on a production resource. " +
        "This decision is never left to the AI verdict alone, regardless of what Agent 3 concluded.",
    };
  }

  if (verdict.verdict === "ESCALATE") {
    return {
      decision: "PUNCH_OUT",
      reason: `Agent 3 verdict was ESCALATE: ${verdict.verdict_reasoning}`,
    };
  }

  // Agent 3's own prompt says to escalate if any remediation needs human sign-off.
  if (reviewedItems(verdict).some((r) => r.requires_human_signoff === true)) {
    return {
      decision: "PUNCH_OUT",
      reason: "Agent 3 flagged at least one remediation as requiring human sign-off, so the workflow escalates.",
    };
  }

  if (hasCriticalOrHighSecurityExposure(findings) && verdict.verdict !== "APPROVE") {
    return {
      decision: "PUNCH_OUT",
      reason: "CRITICAL/HIGH security exposure present and Agent 3 did not fully approve the remediation.",
    };
  }

  // Agent 3 said APPROVE, but its own per-remediation checks say the fix is
  // invalid or does not resolve the issue. Send it back, up to the loop cap.
  const flawed = reviewedItems(verdict).some((r) => r.technically_valid === false || r.actually_resolves_issue === false);
  if (verdict.verdict === "APPROVE" && flawed) {
    if (reviseCount >= MAX_REVISE_LOOPS) {
      return {
        decision: "PUNCH_OUT",
        reason: `Agent 3 found an invalid or non-resolving remediation after ${reviseCount} REVISE loops, so the workflow escalates.`,
      };
    }
    return {
      decision: "REVISE",
      reason: "Agent 3 approved the verdict but marked a remediation as technically invalid or not resolving the issue.",
    };
  }

  if (verdict.verdict === "REVISE") {
    if (reviseCount >= MAX_REVISE_LOOPS) {
      return {
        decision: "PUNCH_OUT",
        reason: `Agent 3 returned REVISE ${reviseCount} times without reaching APPROVE, treated as ESCALATE to avoid looping indefinitely.`,
      };
    }
    return { decision: "REVISE", reason: verdict.verdict_reasoning };
  }

  return { decision: "APPROVED", reason: verdict.verdict_reasoning };
}

module.exports = { evaluateRiskGate, MAX_REVISE_LOOPS };
