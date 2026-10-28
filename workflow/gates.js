// Deterministic gates. These are the parts of governance that must NOT depend
// on an LLM's judgment: the coordinator reasons about what to dispatch and how
// to resolve challenges, but it cannot approve past a human checkpoint. If any
// gate here fires, the run stops at PENDING_HUMAN_DECISION no matter what
// disposition the coordinator returned.

const { RANK } = require('./schemas');

const atLeast = (sev, min) => RANK[sev] >= RANK[min];

/**
 * @param {object} state  per-workflow state: { [workflow]: { analysis, remediation, reviews[] } }
 *   where analysis/remediation are { artifact_id, data } and reviews is an array of the same.
 */
function evaluateHardGates({ state, environment }) {
  const gates = [];
  const add = (id, workflow, reason) => gates.push({ id, workflow, reason });
  const production = environment === 'production';

  for (const [wf, s] of Object.entries(state)) {
    const analysis = s.analysis && s.analysis.data;
    if (!analysis) {
      add('NO_ANALYSIS', wf, `${wf}: workflow was launched but no validated analysis exists (fail closed)`);
      continue;
    }
    if (atLeast(analysis.risk_level, 'CRITICAL')) add('CRITICAL_RISK', wf, `${wf}: risk level is CRITICAL`);
    if (production && atLeast(analysis.risk_level, 'HIGH')) add('HIGH_RISK_PRODUCTION', wf, `${wf}: ${analysis.risk_level} risk in a production environment`);

    if (wf === 'terraform') {
      const destructive = analysis.destructive_changes.filter((c) => c.environment === 'production' || production);
      if (destructive.length) add('PRODUCTION_DESTRUCTIVE', wf, `terraform: ${destructive.length} destructive change(s) on production resources: ${destructive.map((c) => c.resource).join(', ')}`);
    }
    if (wf === 'kubernetes') {
      const rbac = analysis.security_issues.filter((i) => i.type === 'rbac' && atLeast(i.severity, 'HIGH'));
      if (rbac.length) add('RBAC_HIGH_SEVERITY', wf, `kubernetes: ${rbac.length} HIGH/CRITICAL RBAC finding(s): ${rbac.map((i) => i.resource_name).join(', ')}`);
    }
    if (wf === 'iam') {
      const broad = analysis.access_issues.filter((i) => i.type === 'overly_broad_permissions' && atLeast(i.severity, 'HIGH'));
      if (broad.length) add('IAM_BROAD_PERMISSIONS', wf, `iam: ${broad.length} HIGH/CRITICAL overly broad permission finding(s)`);
    }

    const reviews = s.reviews || [];
    if (reviews.length === 0) {
      add('NO_ADVERSARIAL_REVIEW', wf, `${wf}: no adversarial review is on record for this workflow (fail closed)`);
    } else if (
      reviews[reviews.length - 1].for.analysis !== s.analysis.artifact_id ||
      reviews[reviews.length - 1].for.remediation !== (s.remediation ? s.remediation.artifact_id : null)
    ) {
      add('NO_ADVERSARIAL_REVIEW', wf, `${wf}: the latest adversarial review predates the current artifacts (stale review, fail closed)`);
    } else {
      const latest = reviews[reviews.length - 1].data;
      if (latest.verdict === 'ESCALATE') add('REVIEWER_ESCALATE', wf, `${wf}: adversarial reviewer verdict is ESCALATE`);
      if (latest.verdict === 'REVISE') add('UNRESOLVED_REVISION', wf, `${wf}: adversarial reviewer still requires revision (challenges unresolved)`);
      const signoff = latest.challenges.filter((c) => c.requires_human_signoff);
      if (signoff.length) add('REVIEWER_REQUIRES_SIGNOFF', wf, `${wf}: ${signoff.length} challenge(s) require human sign-off`);
      const critical = latest.challenges.filter((c) => c.severity === 'CRITICAL');
      if (critical.length && latest.verdict !== 'APPROVE') add('CRITICAL_CHALLENGE_OPEN', wf, `${wf}: ${critical.length} CRITICAL challenge(s) remain open`);
    }
  }
  return { requires_human: gates.length > 0, gates };
}

// Deterministic per-artifact status. The report heading is derived from this,
// so the heading can never be wrong because it never passes through an LLM.
function workflowStatus(wfState, gates, workflow) {
  const hasAnalysis = Boolean(wfState && wfState.analysis);
  const reviews = (wfState && wfState.reviews) || [];
  const latest = reviews.length ? reviews[reviews.length - 1].data : null;
  const gated = gates.some((g) => g.workflow === workflow);
  return hasAnalysis && latest && latest.verdict === 'APPROVE' && !gated ? 'PASS' : 'FAIL';
}

/**
 * Substance assessment: is each workflow real consulting work?
 * Elevates (routes to a human, blocks final disposition) if any workflow is
 * toy or two or more are peripheral. This is a routing judgment, not a failure.
 */
function evaluateSubstance(doc) {
  const wfs = doc.workflows;
  const toy = wfs.filter((w) => w.category === 'toy');
  const peripheral = wfs.filter((w) => w.category === 'peripheral');
  const reasons = [];
  if (toy.length) reasons.push(`workflow(s) scored toy: ${toy.map((w) => w.id).join(', ')}`);
  if (peripheral.length >= 2) reasons.push(`two or more workflows scored peripheral: ${peripheral.map((w) => w.id).join(', ')}`);
  return {
    elevate: reasons.length > 0,
    reasons,
    counts: { core: wfs.filter((w) => w.category === 'core').length, peripheral: peripheral.length, toy: toy.length },
    assessments: wfs.map((w) => ({ id: w.id, category: w.category, rationale: w.rationale })),
  };
}

/**
 * Final status before any human decision. Fail closed: anything unresolved,
 * incomplete or overridden stops at PENDING_HUMAN_DECISION.
 */
function computeFinalStatus({ gateResult, substance, disposition, incompleteReason }) {
  const reasons = [];
  if (gateResult.requires_human) reasons.push(...gateResult.gates.map((g) => `[${g.id}] ${g.reason}`));
  if (substance.elevate) reasons.push(...substance.reasons.map((r) => `[SUBSTANCE_ELEVATION] ${r}`));
  if (disposition && disposition.disposition === 'ESCALATE') reasons.push(`[COORDINATOR_ESCALATE] ${disposition.rationale}`);
  if (incompleteReason) reasons.push(`[INCOMPLETE_EXAMINATION] ${incompleteReason}`);
  const requiresHuman = reasons.length > 0;
  return {
    requires_human_decision: requiresHuman,
    final_status: requiresHuman ? 'PENDING_HUMAN_DECISION' : 'APPROVED',
    reasons,
    coordinator_overridden: Boolean(disposition && disposition.disposition === 'APPROVE' && requiresHuman),
  };
}

/**
 * Resolve the effective status of a stored run against the append-only
 * decision ledger. The run record itself is never modified.
 */
function resolveFinalStatus(run, decisions) {
  if (!run.requires_human_decision) return run.final_status;
  const latest = decisions.length ? decisions[decisions.length - 1] : null;
  if (!latest) return 'PENDING_HUMAN_DECISION';
  return latest.decision === 'continue' ? 'HUMAN_CONTINUE' : 'HUMAN_REJECTED';
}

module.exports = { evaluateHardGates, workflowStatus, evaluateSubstance, computeFinalStatus, resolveFinalStatus };
