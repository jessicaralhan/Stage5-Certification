// Stage 3 guarantees for every agent in the delegation system: a prompt, at
// least three NAMED evaluation criteria, and measured results written to
// evals/results/<eval_id>.results.json by evals/run-evals.js.
//
// Each criterion is a deterministic check on real model output (no LLM grader),
// so the same output always gives the same verdict. criteria names are the
// `name` fields below; evals/README.md maps each prompt instruction to them.

const path = require('path');
const fs = require('fs');
const sub = require('../workflow/subagents');

const ROOT = path.join(__dirname, '..');
const td = (f) => path.join(ROOT, 'test-data', f);
const text = (v) => JSON.stringify(v || '').toLowerCase();
// The raw text of every proposed fix (not JSON-escaped, so quotes inside a fix stay quotes).
const fixText = (rem) => {
  if (!rem || !rem.ok || !rem.result) return '';
  const r = rem.result;
  return (r.remediations || r.fixes || []).map((x) => x.proposed_fix || x.concrete_yaml || x.concrete_policy_change || '').join('\n');
};

const pass = (detail = '') => ({ pass: true, detail });
const fail = (detail) => ({ pass: false, detail });
const when = (cond, ok, bad) => (cond ? pass(ok) : fail(bad));

// ------------------------------------------------------ shared criterion builders

const schemaValid = (key) => ({ name: 'schema-valid', check: (r) => when(r[key] && r[key].ok, `${key} passed schema validation`, `${key} failed: ${JSON.stringify(r[key] && r[key].error)}`) });
const bareJson = (key) => ({ name: 'bare-json-output', check: (r) => when(r.raw && r.raw[key] === true, 'output was a bare JSON object', 'output was wrapped in prose or code fences') });
const remediationConcrete = (key = 'remediation') => ({ name: 'one-concrete-fix-per-finding', check: (r) => when(r[key] && r[key].ok, 'one fix per finding, none a placeholder', `remediation rejected: ${JSON.stringify(r[key] && r[key].error)}`) });

// A workflow eval case: analyze (and optionally remediate) one fixture.
function workflowCase({ workflow, id, description, file, environment, remediate = false, criteria }) {
  return {
    id, description, input: path.relative(ROOT, file), environment, criteria,
    async run(env) {
      const ctx = env.makeContext({ inputFile: file, environment });
      const analysis = await sub.runWorkflowStep(ctx, workflow, { step: 'analyze' });
      const out = { analysis, raw: {}, state: ctx.state };
      if (analysis.ok) out.raw.analysis = ctx.state[workflow].analysis.json_bare;
      if (remediate && analysis.ok) {
        out.remediation = await sub.runWorkflowStep(ctx, workflow, { step: 'remediate' });
        if (out.remediation.ok && out.remediation.result) out.raw.remediation = ctx.state[workflow].remediation.json_bare;
      }
      return out;
    },
  };
}

// ------------------------------------------------------------------ the evals

const terraform = {
  id: 'terraform', workflow: 'terraform_workflow', title: 'Terraform Safety Review (analyzer + remediation generator)',
  prompts: ['prompts/workflow1-terraform-analyzer.md', 'prompts/workflow1-terraform-generator.md'],
  cases: [
    workflowCase({
      workflow: 'terraform', id: 'prod-destructive-replacement', description: 'Production database replaced because db_subnet_group_name changed', file: td('terraform-destructive.tf'), environment: 'production', remediate: true,
      criteria: [
        schemaValid('analysis'), bareJson('analysis'), remediationConcrete(),
        { name: 'flags-prod-destroy', check: (r) => when(r.analysis.ok && r.analysis.result.destructive_changes.some((c) => c.resource.includes('aws_rds_cluster.prod') && c.environment === 'production'), 'aws_rds_cluster.prod flagged as a production destructive change', 'did not flag the production forced replacement') },
        { name: 'rates-critical', check: (r) => when(r.analysis.ok && r.analysis.result.risk_level === 'CRITICAL' && r.analysis.result.destructive_changes.some((c) => c.severity === 'CRITICAL'), 'rated CRITICAL', `risk_level ${r.analysis.ok && r.analysis.result.risk_level}`) },
        { name: 'names-forcing-attribute', check: (r) => when(r.analysis.ok && r.analysis.result.destructive_changes.some((c) => /db_subnet_group_name/.test(c.forcing_attribute)), 'named db_subnet_group_name', 'did not name the attribute that forces replacement') },
      ],
    }),
    workflowCase({
      workflow: 'terraform', id: 'benign-plan-no-false-positives', description: 'Creates a bucket with encryption and a private security group; nothing destructive and nothing public', file: td('terraform-benign.tf'), environment: 'production',
      criteria: [
        schemaValid('analysis'), bareJson('analysis'),
        { name: 'no-false-destructive', check: (r) => when(r.analysis.ok && r.analysis.result.destructive_changes.length === 0, 'no destructive change invented', 'reported a destructive change in a create-only plan') },
        { name: 'no-false-public-exposure', check: (r) => when(r.analysis.ok && !r.analysis.result.security_exposure.some((s) => /0\.0\.0\.0\/0|public internet|publicly accessible/i.test(s.issue)), 'no public-exposure claim', 'claimed public exposure that is not in the plan') },
      ],
    }),
    workflowCase({
      workflow: 'terraform', id: 'open-cidr-ssh', description: 'Bastion SSH opened to 0.0.0.0/0 in production', file: td('terraform-open-cidr.tf'), environment: 'production', remediate: true,
      criteria: [
        schemaValid('analysis'), bareJson('analysis'), remediationConcrete(),
        { name: 'flags-open-cidr', check: (r) => when(r.analysis.ok && r.analysis.result.security_exposure.some((s) => /bastion/.test(s.resource) && /0\.0\.0\.0\/0/.test(s.issue)), 'bastion 0.0.0.0/0 flagged', 'missed the open CIDR on the bastion SG') },
        { name: 'open-cidr-rated-high-or-critical', check: (r) => when(r.analysis.ok && r.analysis.result.security_exposure.some((s) => ['HIGH', 'CRITICAL'].includes(s.severity)), 'rated HIGH or above', 'public SSH exposure rated below HIGH') },
        { name: 'fix-gives-value-or-command', check: (r) => when(r.remediation && r.remediation.ok && /cidr_blocks|aws ec2|data\s+"aws_|var\./.test(fixText(r.remediation)), 'fix names a CIDR setting, command or data source', 'fix is generic advice with no value or command') },
      ],
    }),
  ],
};

const kubernetes = {
  id: 'kubernetes', workflow: 'kubernetes_workflow', title: 'Kubernetes Security Review (analyzer + hardening generator)',
  prompts: ['prompts/workflow2-kubernetes-analyzer.md', 'prompts/workflow2-kubernetes-generator.md'],
  cases: [
    workflowCase({
      workflow: 'kubernetes', id: 'rbac-wildcard-binding', description: 'ClusterRole with wildcard apiGroups/resources/verbs bound to a service account', file: td('k8s-rbac-overly-permissive.yaml'), environment: 'production', remediate: true,
      criteria: [
        schemaValid('analysis'), bareJson('analysis'), remediationConcrete(),
        { name: 'detects-rbac-wildcard', check: (r) => when(r.analysis.ok && r.analysis.result.security_issues.some((i) => i.type === 'rbac' && ['HIGH', 'CRITICAL'].includes(i.severity)), 'HIGH/CRITICAL rbac finding', 'no HIGH/CRITICAL rbac finding') },
        { name: 'names-the-role', check: (r) => when(r.analysis.ok && text(r.analysis.result.security_issues).match(/admin-like-role|app-admin-binding/), 'names the role or binding', 'did not name admin-like-role / app-admin-binding') },
        { name: 'risk-elevated', check: (r) => when(r.analysis.ok && ['HIGH', 'CRITICAL'].includes(r.analysis.result.risk_level), 'risk HIGH or CRITICAL', 'risk_level too low for cluster-admin equivalent') },
      ],
    }),
    workflowCase({
      workflow: 'kubernetes', id: 'insecure-pod', description: 'Privileged root pod with hostNetwork and hostPID', file: td('k8s-insecure-pod.yaml'), environment: 'production',
      criteria: [
        schemaValid('analysis'), bareJson('analysis'),
        { name: 'detects-privileged-pod', check: (r) => when(r.analysis.ok && r.analysis.result.security_issues.some((i) => /privileged|hostnetwork|hostpid/i.test(i.description)), 'privileged/host namespace issue found', 'missed privileged / hostNetwork / hostPID') },
        { name: 'detects-multiple-issue-types', check: (r) => when(r.analysis.ok && new Set(r.analysis.result.security_issues.map((i) => i.type)).size >= 2, 'at least two distinct issue types', 'found fewer than two kinds of issue') },
      ],
    }),
    workflowCase({
      workflow: 'kubernetes', id: 'hardened-manifest-not-critical', description: 'Namespaced least-privilege Role, default-deny-style NetworkPolicy, non-root read-only container', file: td('k8s-benign.yaml'), environment: 'production',
      criteria: [
        schemaValid('analysis'), bareJson('analysis'),
        { name: 'no-false-critical', check: (r) => when(r.analysis.ok && r.analysis.result.risk_level !== 'CRITICAL' && !r.analysis.result.security_issues.some((i) => i.severity === 'CRITICAL'), 'no CRITICAL raised on a hardened manifest', 'raised CRITICAL on a hardened manifest') },
      ],
    }),
  ],
};

const iam = {
  id: 'iam', workflow: 'iam_workflow', title: 'IAM Policy Audit (analyzer + least-privilege generator)',
  prompts: ['prompts/workflow3-iam-analyzer.md', 'prompts/workflow3-iam-generator.md'],
  cases: [
    workflowCase({
      workflow: 'iam', id: 'wildcard-action-and-resource', description: 'Allow Action * on Resource *', file: td('iam-overly-broad-policy.json'), environment: 'production', remediate: true,
      criteria: [
        schemaValid('analysis'), bareJson('analysis'), remediationConcrete(),
        { name: 'detects-wildcard-permissions', check: (r) => when(r.analysis.ok && r.analysis.result.access_issues.some((i) => i.type === 'overly_broad_permissions'), 'overly_broad_permissions found', 'missed the wildcard policy') },
        { name: 'rates-critical', check: (r) => when(r.analysis.ok && r.analysis.result.risk_level === 'CRITICAL', 'rated CRITICAL', `risk_level ${r.analysis.ok && r.analysis.result.risk_level}`) },
        { name: 'fix-enumerates-actions', check: (r) => when(r.remediation && r.remediation.ok && /\b[a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9]*/.test(fixText(r.remediation)), 'fix names specific service:Action values', 'fix does not enumerate specific actions') },
      ],
    }),
    workflowCase({
      workflow: 'iam', id: 'least-privilege-not-critical', description: 'Single s3:GetObject on one prefix, with MFA and source-IP conditions', file: td('iam-least-privilege.json'), environment: 'production',
      criteria: [
        schemaValid('analysis'), bareJson('analysis'),
        { name: 'no-false-critical', check: (r) => when(r.analysis.ok && r.analysis.result.risk_level !== 'CRITICAL' && r.analysis.result.risk_level !== 'HIGH', 'not rated HIGH or CRITICAL', 'rated a least-privilege policy HIGH or CRITICAL') },
      ],
    }),
  ],
};

// ----- reviewer and writer evals run on fixed artifacts so the reviewer/writer
// ----- are measured in isolation from the producing agents

const PLAN = td('terraform-destructive.tf');
const baseAnalysis = {
  destructive_changes: [{ resource: 'aws_rds_cluster.prod', action: 'destroy_and_recreate', forcing_attribute: 'db_subnet_group_name', environment: 'production', severity: 'CRITICAL' }],
  security_exposure: [], cost_notes: ['Replacement briefly doubles database cost.'], risk_level: 'CRITICAL',
};
const trapRemediation = {
  remediations: [{ resource: 'aws_rds_cluster.prod', issue: 'db_subnet_group_name change forces replacement of the production cluster.', proposed_fix: 'Add lifecycle { prevent_destroy = true } to aws_rds_cluster.prod so Terraform refuses to destroy it.', fix_type: 'lifecycle_change', severity: 'CRITICAL' }],
};

function presetState(ctx, workflow, analysis, remediation) {
  ctx.state[workflow] = { analysis: { artifact_id: 'A1-terraform-analysis', data: analysis, json_bare: true }, remediation: remediation ? { artifact_id: 'A2-terraform-remediation', data: remediation, json_bare: true } : null, reviews: [] };
}

const adversarialReviewer = {
  id: 'adversarial_reviewer', workflow: 'adversarial_reviewer', title: 'Adversarial Reviewer (own context, read_file)',
  prompts: ['prompts/adversarial-reviewer.md'],
  cases: [
    {
      id: 'prevent-destroy-trap', description: 'A fix that only blocks the destroy and so makes the required change impossible to apply', input: path.relative(ROOT, PLAN), environment: 'production',
      async run(env) {
        const ctx = env.makeContext({ inputFile: PLAN, environment: 'production' });
        presetState(ctx, 'terraform', baseAnalysis, trapRemediation);
        const review = await sub.runAdversarialReviewer(ctx, { workflow: 'terraform' });
        return { review, raw: { review: review.ok ? ctx.state.terraform.reviews[0].json_bare !== false : false }, state: ctx.state };
      },
      criteria: [
        { name: 'schema-valid', check: (r) => when(r.review.ok, 'review passed schema validation', `review rejected: ${JSON.stringify(r.review.error)}`) },
        { name: 'does-not-approve-flawed-fix', check: (r) => when(r.review.ok && r.review.result.verdict !== 'APPROVE', `verdict ${r.review.ok && r.review.result.verdict}`, 'approved a self-defeating fix') },
        { name: 'catches-self-defeating-fix', check: (r) => when(r.review.ok && /prevent_destroy/.test(text(r.review.result)) && /(replace|apply|block|error|fail|forever|never|prevent)/.test(text(r.review.result)), 'explains that prevent_destroy blocks the required replacement', 'did not identify that prevent_destroy defeats the fix') },
        { name: 'verifies-against-source-file', check: (r) => when(r.review.ok && r.state.terraform.reviews[0].file_reads >= 1, 'read the source file at least once', 'never read the source file') },
        { name: 'file-quotes-are-genuine', check: (r) => when(r.review.ok && r.review.evidence_check.unverified.length === 0, `${r.review.ok && r.review.evidence_check.verified} file quote(s) verified, none invented`, `unverified quotes: ${r.review.ok && r.review.evidence_check.unverified}`) },
        { name: 'escalates-prod-replacement', check: (r) => when(r.review.ok && r.review.result.verdict === 'ESCALATE', 'ESCALATE', `verdict ${r.review.ok && r.review.result.verdict}`) },
      ],
    },
    {
      id: 'analysis-missed-a-finding', description: 'An analysis that reports nothing for a plan that replaces a production database', input: path.relative(ROOT, PLAN), environment: 'production',
      async run(env) {
        const ctx = env.makeContext({ inputFile: PLAN, environment: 'production' });
        presetState(ctx, 'terraform', { destructive_changes: [], security_exposure: [], cost_notes: [], risk_level: 'LOW' }, null);
        const review = await sub.runAdversarialReviewer(ctx, { workflow: 'terraform' });
        return { review, raw: {}, state: ctx.state };
      },
      criteria: [
        { name: 'schema-valid', check: (r) => when(r.review.ok, 'review passed schema validation', `review rejected: ${JSON.stringify(r.review.error)}`) },
        { name: 'catches-missed-finding', check: (r) => when(r.review.ok && r.review.result.verdict !== 'APPROVE' && r.review.result.challenges.some((c) => c.artifact === 'analysis'), 'challenged the analysis', 'approved an analysis that missed a production replacement') },
        { name: 'verifies-against-source-file', check: (r) => when(r.review.ok && r.state.terraform.reviews[0].file_reads >= 1, 'read the source file', 'never read the source file') },
        { name: 'file-quotes-are-genuine', check: (r) => when(r.review.ok && r.review.evidence_check.unverified.length === 0, 'no invented quotes', `unverified quotes: ${r.review.ok && r.review.evidence_check.unverified}`) },
      ],
    },
  ],
};

const finalReviewWriter = {
  id: 'final_review_writer', workflow: 'final_review_writer', title: 'Final Review Writer (prose only)',
  prompts: ['prompts/final-review-writer.md'],
  cases: [
    {
      id: 'escalated-production-replacement', description: 'Synthesize a failing, escalated examination without softening it or adding findings', input: path.relative(ROOT, PLAN), environment: 'production',
      async run(env) {
        const ctx = env.makeContext({ inputFile: PLAN, environment: 'production' });
        presetState(ctx, 'terraform', baseAnalysis, trapRemediation);
        ctx.state.terraform.reviews.push({
          artifact_id: 'A3-terraform-review', for: { analysis: 'A1-terraform-analysis', remediation: 'A2-terraform-remediation' }, file_reads: 1, evidence_check: { detail: [] },
          data: {
            verdict: 'ESCALATE', reasoning: 'prevent_destroy on aws_rds_cluster.prod blocks the replacement that db_subnet_group_name requires.',
            challenges: [{ id: 'C1', artifact: 'remediation', target: 'aws_rds_cluster.prod', severity: 'CRITICAL', claim: 'prevent_destroy makes the required replacement impossible to apply', evidence_source: 'reasoning', evidence: 'terraform apply errors when a plan destroys a prevent_destroy resource', requires_human_signoff: true }],
            verified_claims: ['aws_rds_cluster.prod is marked must be replaced'],
          },
        });
        const write = await sub.runFinalReviewWriter(ctx, { coordinator_notes: 'Escalating: production replacement of aws_rds_cluster.prod needs a human decision.' });
        return { write, raw: { write: write.ok }, rawTexts: env.rawTexts(), state: ctx.state, finalReview: ctx.finalReview };
      },
      criteria: [
        { name: 'sections-complete', check: (r) => when(r.write.ok && r.finalReview && r.finalReview.executive_summary && r.finalReview.sections.terraform, 'executive summary and a section for every executed workflow', `writer rejected: ${JSON.stringify(r.write.error)}`) },
        { name: 'no-new-findings', check: (r) => when(r.write.ok, 'every backticked identifier and severity word exists in the moderated context', `guardrail rejected the prose: ${JSON.stringify(r.write.error && r.write.error.details)}`) },
        { name: 'writes-no-headings', check: (r) => { const raw = r.rawTexts[r.rawTexts.length - 1] || ''; let body; try { body = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch (e) { return fail('output was not JSON'); } const prose = [body.executive_summary, ...Object.values(body.sections || {})].join('\n'); return when(!/^\s{0,3}#{1,6}\s/m.test(prose), 'no markdown headings in the LLM prose', 'the model wrote markdown headings (the harness would demote them, but the instruction was ignored)'); } },
        { name: 'does-not-soften-failure', check: (r) => when(r.write.ok && !/\bPASS(ED)?\b|\bapproved\b|no (further )?action (is )?(needed|required)/i.test(JSON.stringify(r.finalReview)), 'prose does not claim approval for an ESCALATE result', 'prose claims approval or PASS for an escalated, failing examination') },
      ],
    },
  ],
};

const EVALS = [terraform, kubernetes, iam, adversarialReviewer, finalReviewWriter];

module.exports = { EVALS };
