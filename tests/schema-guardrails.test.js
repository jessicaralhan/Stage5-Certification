// Deterministic schema enforcement at the delegation boundary.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../workflow/schemas');
const { runExamination } = require('../workflow/coordinator');
const { createScriptedClient } = require('./helpers/scripted-client');
const F = require('./helpers/fixtures');
const coordinatorCalls = (client) => client.calls.filter((c) => c.tools && c.tools.some((t) => t.name.startsWith('launch_')));

test('terraform analysis: valid passes; wrong enum, missing field and inconsistent risk_level fail', () => {
  assert.ok(S.validateTerraformAnalysis(F.tfAnalysis).valid);
  assert.ok(!S.validateTerraformAnalysis({ ...F.tfAnalysis, risk_level: 'LOW' }).valid, 'risk_level must be the highest finding severity');
  assert.ok(!S.validateTerraformAnalysis({ ...F.tfAnalysis, destructive_changes: [{ ...F.tfAnalysis.destructive_changes[0], action: 'replace' }] }).valid);
  assert.ok(!S.validateTerraformAnalysis({ security_exposure: [], cost_notes: [], risk_level: 'LOW' }).valid);
});

test('kubernetes and iam analyses validate their own schemas', () => {
  const k8s = { security_issues: [{ type: 'rbac', severity: 'CRITICAL', resource_kind: 'ClusterRole', resource_name: 'admin-like-role', namespace: 'cluster-wide', description: 'wildcard verbs' }], summary: 'bad', risk_level: 'CRITICAL' };
  assert.ok(S.validateKubernetesAnalysis(k8s).valid);
  assert.ok(!S.validateKubernetesAnalysis({ ...k8s, security_issues: [{ ...k8s.security_issues[0], type: 'weird' }] }).valid);
  const iam = { access_issues: [{ type: 'overly_broad_permissions', severity: 'CRITICAL', affected_principals: ['r'], affected_resources: ['*'], description: 'Action *' }], summary: 'bad', risk_level: 'CRITICAL' };
  assert.ok(S.validateIamAnalysis(iam).valid);
  assert.ok(!S.validateIamAnalysis({ ...iam, access_issues: [{ ...iam.access_issues[0], affected_principals: 'r' }] }).valid);
});

test('remediation guardrail: one per finding, no invented findings, no placeholders, but ordinary HCL lists are fine', () => {
  assert.ok(S.validateTerraformRemediation(F.tfRemediation, F.tfAnalysis).valid);
  const twice = { remediations: [...F.tfRemediation.remediations, ...F.tfRemediation.remediations] };
  assert.ok(!S.validateTerraformRemediation(twice, F.tfAnalysis).valid, 'exactly one per finding');
  const invented = { remediations: [{ ...F.tfRemediation.remediations[0], resource: 'aws_s3_bucket.made_up' }] };
  assert.ok(!S.validateTerraformRemediation(invented, F.tfAnalysis).valid, 'no invented findings');
  const placeholder = { remediations: [{ ...F.tfRemediation.remediations[0], proposed_fix: 'set cidr_blocks = [TODO]' }] };
  assert.ok(!S.validateTerraformRemediation(placeholder, F.tfAnalysis).valid);
  const hcl = { remediations: [{ ...F.tfRemediation.remediations[0], proposed_fix: 'cidr_blocks = ["10.0.0.0/8"] and lifecycle { prevent_destroy = false }' }] };
  assert.ok(S.validateTerraformRemediation(hcl, F.tfAnalysis).valid, 'a bracketed list is legitimate HCL, not a placeholder');
});

test('review schema: structured challenges and verdict consistency', () => {
  assert.ok(S.validateReview(F.review('REVISE', [F.challenge()])).valid);
  assert.ok(S.validateReview(F.review('APPROVE', [])).valid);
  assert.ok(!S.validateReview(F.review('REVISE', [])).valid, 'REVISE needs a challenge');
  assert.ok(!S.validateReview(F.review('APPROVE', [F.challenge()])).valid, 'APPROVE with a HIGH challenge is inconsistent');
  assert.ok(!S.validateReview(F.review('REVISE', [F.challenge({ requires_human_signoff: true })])).valid, 'sign-off means ESCALATE');
  assert.ok(!S.validateReview(F.review('REVISE', [F.challenge({ evidence_source: 'vibes' })])).valid);
  assert.ok(!S.validateReview(F.review('REVISE', [F.challenge(), F.challenge()])).valid, 'duplicate challenge ids');
  assert.ok(!S.validateReview({ verdict: 'MAYBE', reasoning: 'x', challenges: [], verified_claims: [] }).valid);
});

test('final review: non-empty prose per executed workflow, no new identifiers, no new severities, headings demoted', () => {
  const ctx = JSON.stringify({ aws_rds_cluster: 'aws_rds_cluster.prod', sev: 'CRITICAL' });
  const ok = { executive_summary: 'Fine.', sections: { terraform: 'About `aws_rds_cluster.prod`, a CRITICAL item.' } };
  assert.ok(S.validateFinalReview(ok, { workflows: ['terraform'], sourceText: ctx }).valid);
  assert.ok(!S.validateFinalReview({ ...ok, sections: { terraform: '' } }, { workflows: ['terraform'], sourceText: ctx }).valid, 'empty markdown');
  assert.ok(!S.validateFinalReview({ ...ok, sections: { terraform: 'Also `aws_s3_bucket.new` is exposed.' } }, { workflows: ['terraform'], sourceText: ctx }).valid, 'invented finding');
  assert.ok(!S.validateFinalReview({ ...ok, sections: { terraform: 'This is LOW priority.' } }, { workflows: ['terraform'], sourceText: ctx }).valid, 'severity not in the findings');
  assert.ok(!S.validateFinalReview({ ...ok, sections: { terraform: 'x', kubernetes: 'y' } }, { workflows: ['terraform'], sourceText: ctx }).valid, 'section for a workflow that did not run');
  assert.strictEqual(S.sanitizeProse('# Title\ntext\n### Deep'), '**Title**\ntext\n**Deep**');
});

test('disposition schema', () => {
  assert.ok(S.validateDisposition({ disposition: 'ESCALATE', rationale: 'r', workflows_reviewed: ['terraform'], unresolved_challenges: [] }).valid);
  assert.ok(!S.validateDisposition({ disposition: 'YOLO', rationale: 'r', workflows_reviewed: ['terraform'], unresolved_challenges: [] }).valid);
});

test('a sub-agent returning garbage reaches the coordinator only as a structured error, never as data', async () => {
  const dir = F.tmpDir();
  const bad = [
    ['not json at all, sorry', 'INVALID_JSON'],
    [JSON.stringify({ ...F.tfAnalysis, risk_level: 'LOW' }), 'SCHEMA_VALIDATION_FAILED'],
  ];
  for (const [raw, code] of bad) {
    const client = createScriptedClient({
      coordinator: (results) => (results.length ? { final: { disposition: 'ESCALATE', rationale: `error ${results[0].body.error.code}`, workflows_reviewed: ['terraform'], unresolved_challenges: [] } } : { tool: 'launch_terraform_workflow', input: { step: 'analyze' } }),
      analyzer: () => raw,
    });
    const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });
    const answer = coordinatorCalls(client)[1].messages.at(-1).content[0];
    const body = JSON.parse(answer.content);
    assert.strictEqual(answer.is_error, true);
    assert.strictEqual(body.ok, false);
    assert.strictEqual(body.error.code, code);
    assert.strictEqual(body.error.retryable, true);
    assert.ok(!answer.content.includes('sorry'), 'raw model text is not forwarded');
    assert.strictEqual(Object.keys(run.workflows.terraform || {}).length ? run.workflows.terraform.analysis : null, null, 'nothing invalid was stored as an artifact');
    assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION');
  }
});

test('a truncated model output is reported as OUTPUT_TRUNCATED', async () => {
  const dir = F.tmpDir();
  const base = createScriptedClient({
    coordinator: (results) => (results.length ? { final: { disposition: 'ESCALATE', rationale: 'truncated', workflows_reviewed: ['terraform'], unresolved_challenges: [] } } : { tool: 'launch_terraform_workflow', input: { step: 'analyze' } }),
    analyzer: () => '{"destructive_changes": [',
  });
  const orig = base.callMessages.bind(base);
  base.callMessages = async (req) => { const r = await orig(req); if (!req.tools) r.stopReason = 'max_tokens'; return r; };
  await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client: base, resultsDir: dir });
  assert.match(coordinatorCalls(base)[1].messages.at(-1).content[0].content, /OUTPUT_TRUNCATED/);
});

test('a run that escalated because a sub-agent failed is distinguishable from one that escalated on the merits', async () => {
  const dir = F.tmpDir();
  const client = createScriptedClient({
    coordinator: (results) => (results.length ? { final: { disposition: 'ESCALATE', rationale: 'analysis kept failing', workflows_reviewed: ['terraform'], unresolved_challenges: [] } } : { tool: 'launch_terraform_workflow', input: { step: 'analyze' } }),
    analyzer: () => 'garbage',
  });
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });
  assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION');
  assert.deepStrictEqual(run.sub_agent_errors.map((e) => e.code), ['INVALID_JSON']);
  const report = fs.readFileSync(path.join(dir, run.correlation_id, 'report.md'), 'utf8');
  assert.match(report, /## Sub-agent Errors/);
  assert.match(report, /INVALID_JSON/);
});
