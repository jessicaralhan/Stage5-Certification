// Deterministic report assembly.
//
// The LLM writes prose. This code writes everything structural: every heading,
// every PASS/FAIL, every findings table, the challenge tables, the coordinator
// disposition and the human-review status. A PASS artifact gets a PASS heading
// and a FAIL artifact gets a FAIL heading because the status is computed by
// workflow/gates.js from the artifacts, and never passes through an LLM.

const { workflowStatus } = require('./gates');
const { WORKFLOW_ORDER } = require('./subagents');

const esc = (v) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const table = (headers, rows) =>
  rows.length
    ? `| ${headers.join(' | ')} |\n| ${headers.map(() => '---').join(' | ')} |\n${rows.map((r) => `| ${r.map(esc).join(' | ')} |`).join('\n')}\n\n`
    : '';

function findingsSection(workflow, a) {
  let out = `**Risk level:** ${a.risk_level}\n\n`;
  if (workflow === 'terraform') {
    out += table(['Resource', 'Action', 'Forcing attribute', 'Environment', 'Severity'], a.destructive_changes.map((c) => [c.resource, c.action, c.forcing_attribute, c.environment, c.severity]));
    out += table(['Resource', 'Security exposure', 'Severity'], a.security_exposure.map((s) => [s.resource, s.issue, s.severity]));
    if (a.cost_notes.length) out += `**Cost notes**\n\n${a.cost_notes.map((n) => `- ${n}`).join('\n')}\n\n`;
  } else if (workflow === 'kubernetes') {
    out += `${a.summary}\n\n`;
    out += table(['Type', 'Kind', 'Name', 'Namespace', 'Severity', 'Issue'], a.security_issues.map((i) => [i.type, i.resource_kind, i.resource_name, i.namespace, i.severity, i.description]));
  } else {
    out += `${a.summary}\n\n`;
    out += table(['Type', 'Principals', 'Severity', 'Issue'], a.access_issues.map((i) => [i.type, (i.affected_principals || []).join(', '), i.severity, i.description]));
  }
  const none = (workflow === 'terraform' && !a.destructive_changes.length && !a.security_exposure.length) ||
    (workflow === 'kubernetes' && !a.security_issues.length) || (workflow === 'iam' && !a.access_issues.length);
  return none ? `${out}No findings were reported.\n\n` : out;
}

function remediationSection(workflow, r) {
  if (!r) return 'No remediation was required.\n\n';
  if (workflow === 'terraform') return table(['Resource', 'Type', 'Proposed fix'], r.remediations.map((x) => [x.resource, x.fix_type, x.proposed_fix]));
  if (workflow === 'kubernetes') return table(['Resource', 'Type', 'Proposed fix'], r.fixes.map((x) => [x.resource, x.fix_type, x.concrete_yaml]));
  return table(['Issue', 'Type', 'Proposed fix'], r.fixes.map((x) => [x.issue, x.fix_type, x.concrete_policy_change]));
}

const TITLES = { terraform: 'Terraform Safety Review', kubernetes: 'Kubernetes Security Review', iam: 'IAM Policy Audit' };

/**
 * @param {object} p
 *   p.correlationId, p.environment, p.inputName, p.state, p.gates (array), p.finalReview (or null),
 *   p.disposition (or null), p.finalStatus ({final_status, reasons, coordinator_overridden}), p.substance, p.audit (summary)
 */
function assembleReport(p) {
  const workflows = WORKFLOW_ORDER.filter((w) => p.state[w] && p.state[w].analysis);
  const statuses = Object.fromEntries(workflows.map((w) => [w, workflowStatus(p.state[w], p.gates, w)]));
  const overall = workflows.length > 0 && workflows.every((w) => statuses[w] === 'PASS') ? 'PASS' : 'FAIL';

  let md = `# Infrastructure Review Report: ${overall}\n\n`;
  md += `- **Correlation ID:** ${p.correlationId}\n- **Input:** ${p.inputName}\n- **Environment:** ${p.environment}\n- **Status:** ${p.finalStatus.final_status}\n\n`;

  md += '## Summary of Results\n\n';
  md += table(['Workflow', 'Result', 'Risk level', 'Reviewer verdict'], workflows.map((w) => {
    const reviews = p.state[w].reviews;
    return [TITLES[w], statuses[w], p.state[w].analysis.data.risk_level, reviews.length ? reviews[reviews.length - 1].data.verdict : 'none'];
  }));

  md += '## Executive Summary\n\n';
  md += p.finalReview ? `${p.finalReview.executive_summary}\n\n` : '_The final review writer did not complete for this examination, so no written synthesis is available. The structured results below are complete._\n\n';

  for (const w of workflows) {
    const s = p.state[w];
    md += `## ${TITLES[w]}: ${statuses[w]}\n\n`;
    if (p.finalReview && p.finalReview.sections[w]) md += `${p.finalReview.sections[w]}\n\n`;
    md += '### Findings\n\n' + findingsSection(w, s.analysis.data);
    md += '### Proposed Remediation\n\n' + remediationSection(w, s.remediation && s.remediation.data);
    const latest = s.reviews.length ? s.reviews[s.reviews.length - 1] : null;
    md += `### Adversarial Review: ${latest ? latest.data.verdict : 'NOT RUN'}\n\n`;
    if (latest) {
      md += `${latest.data.reasoning}\n\n`;
      md += table(['ID', 'Artifact', 'Target', 'Severity', 'Claim', 'Evidence verified', 'Human sign-off'], latest.data.challenges.map((c) => {
        const ev = latest.evidence_check.detail.find((d) => d.id === c.id);
        return [c.id, c.artifact, c.target, c.severity, c.claim, ev && ev.verified === true ? 'yes (quoted from file)' : ev && ev.verified === false ? 'NO (quote not found in file)' : 'reasoning only', c.requires_human_signoff ? 'required' : 'no'];
      }));
      md += `Review rounds: ${s.reviews.length}. Source file reads by the reviewer: ${latest.file_reads}.\n\n`;
    }
  }

  md += '## Coordinator Disposition\n\n';
  md += p.disposition
    ? `**Disposition:** ${p.disposition.disposition}\n\n${p.disposition.rationale}\n\n${p.disposition.unresolved_challenges.length ? `Unresolved: ${p.disposition.unresolved_challenges.join('; ')}\n\n` : ''}`
    : '_The coordinator did not return a valid disposition; the examination is treated as incomplete and requires a human decision._\n\n';
  if (p.finalStatus.coordinator_overridden) md += '**Note:** the coordinator returned APPROVE, but a deterministic gate requires a human decision, so the disposition was overridden.\n\n';

  md += '## Human Review\n\n';
  if (p.finalStatus.requires_human_decision) {
    md += 'A human decision (Continue or Reject) is required before this examination has a final disposition. Reasons:\n\n';
    md += p.finalStatus.reasons.map((r) => `- ${r}`).join('\n') + '\n\n';
    md += `Record it with: \`node punch-out/human-decision-cli.js decide ${p.correlationId} --decision continue|reject --reviewer "Your Name"\`\n\n`;
  } else {
    md += 'No human checkpoint was triggered.\n\n';
  }

  md += '## Substance Assessment\n\n';
  md += table(['Workflow', 'Category', 'Rationale'], p.substance.assessments.map((a) => [a.id, a.category, a.rationale]));
  md += p.substance.elevate ? `Elevated for human review: ${p.substance.reasons.join('; ')}\n\n` : 'No elevation: no workflow is toy and fewer than two are peripheral.\n\n';

  md += '## Audit Trail\n\n';
  md += `Persisted at \`results/${p.correlationId}/audit.jsonl\`. ${p.audit.llm_calls} model calls, ${p.audit.total_input_tokens} input tokens, ${p.audit.total_output_tokens} output tokens, $${p.audit.total_cost_usd.toFixed(6)} total${p.audit.pricing_verified ? '' : ' (rates not yet verified against published pricing)'}.\n\n`;
  md += table(['Agent', 'Calls', 'Input tokens', 'Output tokens', 'Cost (USD)'], Object.entries(p.audit.by_agent).map(([k, v]) => [k, v.calls, v.input_tokens, v.output_tokens, v.cost_usd.toFixed(6)]));
  return { markdown: md, statuses, overall };
}

module.exports = { assembleReport, TITLES };
