// Deterministic (non-AI) guardrail: hard, code-level checks for whether a plan
// touches production in a way that must go to a human. These exist
// independently of any agent's judgment.
//
// Environment is decided by two signals, and either one can make a change
// production: the environment the operator passed to the run (authoritative),
// and the environment label Agent 1 attached to each finding. A finding is
// treated as production unless it is explicitly labelled non-production AND
// the run itself is non-production. A missing or unrecognised label fails
// closed, i.e. counts as production.

function isProductionFinding(finding, runEnvironment) {
  if (runEnvironment === "production") return true;
  return finding.environment !== "non-production";
}

function hasProductionDestructiveChange(findings, runEnvironment) {
  return (findings.destructive_changes || []).some((c) => isProductionFinding(c, runEnvironment));
}

function hasCriticalOrHighSecurityExposure(findings) {
  return (findings.security_exposure || []).some(
    (c) => c.severity === "CRITICAL" || c.severity === "HIGH"
  );
}

// Production CRITICAL/HIGH security exposure is a hard override too: the
// model cannot approve it alone, whatever the reviewer's verdict says.
function hasProductionCriticalOrHighSecurityExposure(findings, runEnvironment) {
  if (runEnvironment === "production") return hasCriticalOrHighSecurityExposure(findings);
  return (findings.security_exposure || []).some(
    (c) => (c.severity === "CRITICAL" || c.severity === "HIGH") && isProductionFinding(c, runEnvironment)
  );
}

module.exports = {
  isProductionFinding,
  hasProductionDestructiveChange,
  hasCriticalOrHighSecurityExposure,
  hasProductionCriticalOrHighSecurityExposure,
};
