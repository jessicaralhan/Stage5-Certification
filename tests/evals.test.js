// Self-test of the Stage 3 eval criteria. Runs the REAL eval definitions through
// the REAL sub-agent code against a scripted model, so every named criterion is
// shown to pass on good output and fail on bad output before a live run.
// (This proves the criteria work; it is not measured evidence about the model.
// Measured results come only from `npm run eval`, into evals/results/.)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EVALS } = require('../evals/definitions');
const { runEval } = require('../evals/run-evals');
const { createScriptedClient } = require('./helpers/scripted-client');
const F = require('./helpers/fixtures');

const manifest = JSON.parse(fs.readFileSync(path.join(F.ROOT, 'agents.manifest.json'), 'utf8'));
const findingsFrom = (prompt) => JSON.parse(prompt.match(/prior review step:\n([\s\S]*?)\n\n(?:Cloud Platform|Environment):/)[1]);

const sgAnalysis = { destructive_changes: [], security_exposure: [{ resource: 'aws_security_group.bastion', issue: 'ingress cidr_blocks opened to 0.0.0.0/0 on port 22', severity: 'CRITICAL' }], cost_notes: [], risk_level: 'CRITICAL' };
const empty = { destructive_changes: [], security_exposure: [], cost_notes: [], risk_level: 'LOW' };

function goodClient(over = {}) {
  return createScriptedClient({
    coordinator: () => ({ final: '{}' }),
    analyzer: (p) => {
      if (/aws_rds_cluster\.prod must be replaced/.test(p)) return JSON.stringify(F.tfAnalysis);
      if (/bastion/.test(p)) return JSON.stringify(sgAnalysis);
      if (/aws_s3_bucket\.app/.test(p)) return JSON.stringify(empty);
      if (/admin-like-role/.test(p)) return JSON.stringify({ security_issues: [{ type: 'rbac', severity: 'CRITICAL', resource_kind: 'ClusterRole', resource_name: 'admin-like-role', namespace: 'cluster-wide', description: 'wildcard verbs on all resources bound to app-sa' }], summary: 'cluster-admin equivalent', risk_level: 'CRITICAL' });
      if (/insecure-pod/.test(p)) return JSON.stringify({ security_issues: [{ type: 'pod_security', severity: 'CRITICAL', resource_kind: 'Pod', resource_name: 'insecure-pod', namespace: 'default', description: 'hostNetwork and hostPID enabled' }, { type: 'security_context', severity: 'CRITICAL', resource_kind: 'Pod', resource_name: 'insecure-pod', namespace: 'default', description: 'privileged container running as root' }], summary: 'unsafe pod', risk_level: 'CRITICAL' });
      if (/api-server-role/.test(p)) return JSON.stringify({ security_issues: [{ type: 'resource_limits', severity: 'LOW', resource_kind: 'Deployment', resource_name: 'api-server', namespace: 'secure-app', description: 'no ephemeral-storage limit' }], summary: 'hardened', risk_level: 'LOW' });
      if (/AllowEverything/.test(p)) return JSON.stringify({ access_issues: [{ type: 'overly_broad_permissions', severity: 'CRITICAL', affected_principals: ['attached principals'], affected_resources: ['*'], description: 'Action * on Resource *' }], summary: 'wildcard policy', risk_level: 'CRITICAL' });
      if (/ReadReportsOnly/.test(p)) return JSON.stringify({ access_issues: [], summary: 'least privilege with MFA and IP conditions', risk_level: 'LOW' });
      throw new Error('scripted analyzer: unknown fixture');
    },
    generator: (p) => {
      const f = findingsFrom(p);
      if (f.destructive_changes || f.security_exposure) {
        return JSON.stringify({ remediations: [...f.destructive_changes, ...f.security_exposure].map((x) => ({ resource: x.resource, issue: x.issue || 'forced replacement', proposed_fix: x.issue ? 'Set cidr_blocks = ["10.20.0.0/16"] on the ingress rule.' : 'Use create_before_destroy with a snapshot restore. Requires a production maintenance window and manual DBA review.', fix_type: x.issue ? 'config_change' : 'process_change', severity: x.severity })) });
      }
      if (f.security_issues) return JSON.stringify({ fixes: f.security_issues.map((x) => ({ resource: x.resource_name, fix_type: x.type, concrete_yaml: 'apiVersion: rbac.authorization.k8s.io/v1\nkind: Role\nrules:\n- apiGroups: [""]\n  resources: ["pods"]\n  verbs: ["get", "list"]', severity: x.severity })) });
      return JSON.stringify({ fixes: f.access_issues.map((x) => ({ issue: x.description, fix_type: 'permission_narrowing', concrete_policy_change: '{"Action": ["s3:GetObject", "s3:PutObject"], "Resource": "arn:aws:s3:::reports-bucket/*"}', severity: x.severity })) });
    },
    reviewer: (p) => {
      if (/prevent_destroy = true/.test(p)) return JSON.stringify(F.review('ESCALATE', [F.challenge({ target: 'aws_rds_cluster.prod', severity: 'CRITICAL', claim: 'prevent_destroy blocks the replacement that db_subnet_group_name requires, so the change can never be applied', requires_human_signoff: true })], { reasoning: 'lifecycle prevent_destroy makes terraform apply error on the required replacement of aws_rds_cluster.prod.' }));
      return JSON.stringify(F.review('REVISE', [F.challenge({ id: 'C1', artifact: 'analysis', claim: 'the plan replaces aws_rds_cluster.prod but the analysis reports no findings' })]));
    },
    writer: () => JSON.stringify({ executive_summary: 'Thank you for the plan. The production replacement of `aws_rds_cluster.prod` is CRITICAL and has been escalated.', sections: { terraform: 'The reviewer found that `prevent_destroy` would block the required change to `aws_rds_cluster.prod`. A human must decide next.' } }),
    ...over,
  });
}

const run = (id, client) => runEval(EVALS.find((e) => e.id === id), { client, model: 'claude-haiku-4-5-20251001', manifest, auditDir: F.tmpDir('eval-audit-'), stamp: 'test' });

test('every eval has a prompt on disk, at least three named criteria, and every case has criteria', () => {
  for (const e of EVALS) {
    for (const p of e.prompts) assert.ok(fs.existsSync(path.join(F.ROOT, p)), `${e.id}: ${p} exists`);
    const names = new Set(e.cases.flatMap((c) => c.criteria.map((k) => k.name)));
    assert.ok(names.size >= 3, `${e.id} has ${names.size} named criteria`);
    for (const c of e.cases) assert.ok(c.criteria.length >= 1 && c.input && c.description);
  }
  const manifestEvals = manifest.sub_agents.map((s) => s.eval_ref);
  for (const ref of manifestEvals) assert.ok(EVALS.some((e) => e.id === ref), `manifest eval_ref ${ref} is defined`);
});

for (const id of ['terraform', 'kubernetes', 'iam', 'adversarial_reviewer', 'final_review_writer']) {
  test(`${id} eval: every criterion passes on good output`, async () => {
    const r = await run(id, goodClient());
    const failing = r.cases.flatMap((c) => c.criteria.filter((k) => !k.pass).map((k) => `${c.id}/${k.name}: ${k.detail}`));
    assert.deepStrictEqual(failing, []);
    assert.strictEqual(r.overall.pass_rate, 1);
    assert.ok(r.named_criteria >= 3 && r.usage.llm_calls > 0 && r.model.requested);
  });
}

test('terraform criteria fail on bad output: missed destroy, wrong severity, fenced JSON, public-exposure false positive', async () => {
  const good = goodClient();
  const client = goodClient({
    analyzer: (p) => {
      if (/aws_rds_cluster\.prod must be replaced/.test(p)) return '```json\n' + JSON.stringify({ ...F.tfAnalysis, destructive_changes: [{ ...F.tfAnalysis.destructive_changes[0], severity: 'MEDIUM', forcing_attribute: 'engine' }], risk_level: 'MEDIUM' }) + '\n```';
      if (/aws_s3_bucket\.app/.test(p)) return JSON.stringify({ ...sgAnalysis, security_exposure: [{ resource: 'aws_security_group.app', issue: 'open to 0.0.0.0/0', severity: 'HIGH' }], risk_level: 'HIGH' });
      return good.callMessages ? JSON.stringify(sgAnalysis) : '';
    },
  });
  const r = await run('terraform', client);
  const failed = new Set(r.cases.flatMap((c) => c.criteria.filter((k) => !k.pass).map((k) => `${c.id}/${k.name}`)));
  for (const expected of ['prod-destructive-replacement/bare-json-output', 'prod-destructive-replacement/rates-critical', 'prod-destructive-replacement/names-forcing-attribute', 'benign-plan-no-false-positives/no-false-public-exposure']) {
    assert.ok(failed.has(expected), `${expected} should fail`);
  }
  assert.ok(!failed.has('prod-destructive-replacement/schema-valid'), 'fenced JSON is tolerated at runtime but measured by the eval');
});

test('reviewer criteria fail when the reviewer approves a self-defeating fix or invents a file quote', async () => {
  const approving = await run('adversarial_reviewer', goodClient({ reviewer: () => JSON.stringify(F.review('APPROVE', [])) }));
  const failed = new Set(approving.cases.flatMap((c) => c.criteria.filter((k) => !k.pass).map((k) => `${c.id}/${k.name}`)));
  assert.ok(failed.has('prevent-destroy-trap/does-not-approve-flawed-fix'));
  assert.ok(failed.has('prevent-destroy-trap/catches-self-defeating-fix'));
  assert.ok(failed.has('analysis-missed-a-finding/catches-missed-finding'));

  const lying = await run('adversarial_reviewer', goodClient({ reviewer: () => JSON.stringify(F.review('ESCALATE', [F.challenge({ evidence: 'a line that is not in the plan file', requires_human_signoff: true })], { reasoning: 'prevent_destroy blocks the replace' })) }));
  assert.ok(lying.cases[0].criteria.find((k) => k.name === 'file-quotes-are-genuine').pass === false);

  const lazy = await run('adversarial_reviewer', goodClient({ reviewerReadsFile: false }));
  assert.ok(lazy.cases.every((c) => c.criteria.find((k) => k.name === 'schema-valid').pass === false), 'a reviewer that never reads the file is rejected, so the eval records it');
});

test('writer criteria fail when the model writes headings or claims PASS for an escalated result', async () => {
  const r = await run('final_review_writer', goodClient({ writer: () => JSON.stringify({ executive_summary: '# Summary\nAll good: PASS.', sections: { terraform: '## Result\nThis is PASS and approved. See `aws_rds_cluster.prod`.' } }) }));
  const failed = new Set(r.cases[0].criteria.filter((k) => !k.pass).map((k) => k.name));
  assert.ok(failed.has('writes-no-headings'));
  assert.ok(failed.has('does-not-soften-failure'));
  const invented = await run('final_review_writer', goodClient({ writer: () => JSON.stringify({ executive_summary: 'Hello.', sections: { terraform: 'Also `aws_s3_bucket.surprise` is exposed.' } }) }));
  assert.ok(invented.cases[0].criteria.find((k) => k.name === 'no-new-findings').pass === false);
});

test('a criterion whose sub-agent failed records a failure with a reason instead of crashing the run', async () => {
  const r = await run('terraform', goodClient({ analyzer: () => 'not json' }));
  for (const c of r.cases) for (const k of c.criteria) assert.strictEqual(k.pass, false);
  assert.ok(r.cases[0].criteria.every((k) => typeof k.detail === 'string' && k.detail.length));
});
