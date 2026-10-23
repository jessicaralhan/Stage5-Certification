// Escalation Gates: Determines what requires human approval/sign-off

// Severity ordering for comparison
const SEVERITY_ORDER = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

function severityValue(level) {
  return SEVERITY_ORDER[level] || 0;
}

/**
 * Determine if findings should be escalated (require human review)
 * @param {Object} workflowFindings - Results from one or more workflows
 * @param {String} environment - production or non-production
 * @returns {Object} { shouldEscalate: bool, reasons: [string], riskLevel: string }
 */
function determineEscalation(workflowFindings, environment) {
  const reasons = [];
  let shouldEscalate = false;

  // Check each workflow for escalation criteria
  Object.entries(workflowFindings).forEach(([workflowType, findings]) => {
    if (!findings || !findings.risk_level) return;

    // Rule 1: CRITICAL in any environment requires escalation
    if (severityValue(findings.risk_level) >= severityValue('CRITICAL')) {
      shouldEscalate = true;
      reasons.push(`${workflowType}: Risk level is CRITICAL`);
    }

    // Rule 2: HIGH + production = escalate
    if (environment === 'production' && severityValue(findings.risk_level) >= severityValue('HIGH')) {
      shouldEscalate = true;
      reasons.push(`${workflowType}: HIGH risk in production environment`);
    }

    // Rule 3: Destructive changes in production (Terraform)
    if (workflowType === 'terraform' && environment === 'production') {
      if (findings.destructive_changes && findings.destructive_changes.length > 0) {
        shouldEscalate = true;
        reasons.push(`terraform: ${findings.destructive_changes.length} destructive change(s) in production`);
      }
    }

    // Rule 4: RBAC wildcard bindings (Kubernetes)
    if (workflowType === 'kubernetes' && findings.security_issues) {
      const rbacWildcards = findings.security_issues.filter(
        i => i.type === 'rbac' && (i.description.includes('*') || i.description.includes('admin'))
      );
      if (rbacWildcards.length > 0) {
        shouldEscalate = true;
        reasons.push(`kubernetes: ${rbacWildcards.length} wildcard RBAC binding(s) detected`);
      }
    }

    // Rule 5: Wildcard IAM permissions
    if (workflowType === 'iam' && findings.access_issues) {
      const wildcards = findings.access_issues.filter(
        i => i.type === 'overly_broad_permissions' && i.description.includes('*')
      );
      if (wildcards.length > 0) {
        shouldEscalate = true;
        reasons.push(`iam: ${wildcards.length} wildcard IAM permission(s) found`);
      }
    }

    // Rule 6: Verdict is ESCALATE (from Reviewer agents)
    if (findings.verdict === 'ESCALATE') {
      shouldEscalate = true;
      reasons.push(`${workflowType}: Reviewer verdict is ESCALATE`);
    }
  });

  return {
    shouldEscalate,
    reasons: reasons.length > 0 ? reasons : [],
    recommendation: shouldEscalate ? 'HUMAN_REVIEW_REQUIRED' : 'AUTO_APPROVED',
  };
}

/**
 * Assess substance level: core, peripheral, or toy
 * @param {Object} workflowFindings
 * @param {String} environment
 * @returns {String} 'core', 'peripheral', or 'toy'
 */
function assessSubstance(workflowFindings, environment) {
  // Check if any production, destructive work is present
  const hasProductionWork = Object.values(workflowFindings).some(
    f => f && f.destructive_changes && f.destructive_changes.length > 0
  );

  const hasSecurityIssues = Object.values(workflowFindings).some(
    f => f && f.security_issues && f.security_issues.length > 0
  );

  const hasAccessIssues = Object.values(workflowFindings).some(
    f => f && f.access_issues && f.access_issues.length > 0
  );

  // Core: Production with destructive changes or security issues
  if (environment === 'production' && (hasProductionWork || hasSecurityIssues || hasAccessIssues)) {
    return 'core';
  }

  // Peripheral: Non-production but has real findings
  if (hasSecurityIssues || hasAccessIssues) {
    return 'peripheral';
  }

  // Toy: No significant findings (e.g., demo/test only)
  return 'toy';
}

/**
 * Create an escalation record for the audit trail
 * @param {String} runId
 * @param {Object} escalationInfo
 * @returns {Object} escalation record
 */
function createEscalationRecord(runId, escalationInfo) {
  return {
    run_id: runId,
    timestamp: new Date().toISOString(),
    should_escalate: escalationInfo.shouldEscalate,
    reasons: escalationInfo.reasons,
    recommendation: escalationInfo.recommendation,
    substance_level: escalationInfo.substance_level,
    environment: escalationInfo.environment,
    status: 'AWAITING_HUMAN_DECISION',
    human_decision: null,
    human_reviewer: null,
    human_review_timestamp: null,
  };
}

module.exports = {
  determineEscalation,
  assessSubstance,
  createEscalationRecord,
  SEVERITY_ORDER,
};
