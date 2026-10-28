// End-to-end governance behavior of the delegation system, run offline against
// a scripted model. The scripted coordinator stands in for the LLM's decisions;
// what is under test is everything the harness guarantees around those decisions.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runExamination } = require('../workflow/coordinator');
const { createScriptedClient } = require('./helpers/scripted-client');
const F = require('./helpers/fixtures');

// A coordinator policy that reasons the way the real prompt instructs.
function terraformPolicy({ finalDisposition = 'APPROVE' } = {}) {
  return (results) => {
    const bodies = results.map((r) => r.body);
    const last = bodies[bodies.length - 1];
    if (!last) return { tool: 'launch_terraform_workflow', input: { step: 'analyze' } };
    if (last.ok === false) return { final: { disposition: 'ESCALATE', rationale: `sub-agent error ${last.error.code}`, workflows_reviewed: ['terraform'], unresolved_challenges: [] } };
    if (last.step === 'analyze') return { tool: 'launch_terraform_workflow', input: { step: 'remediate' } };
    if (last.step === 'remediate') return { tool: 'launch_adversarial_reviewer', input: { workflow: 'terraform' } };
    if (last.step === 'review' && last.result.verdict === 'REVISE') {
      return { tool: 'launch_terraform_workflow', input: { step: 'remediate', challenges: last.result.challenges.map((c) => ({ id: c.id, artifact: c.artifact, target: c.target, claim: c.claim })) } };
    }
    if (last.step === 'review') return { tool: 'launch_final_review_writer', input: { coordinator_notes: 'Reviewed; production replacement present.' } };
    if (last.step === 'write') return { final: { disposition: finalDisposition, rationale: 'Review loop settled.', workflows_reviewed: ['terraform'], unresolved_challenges: [] } };
    return { final: { disposition: 'ESCALATE', rationale: 'unexpected state', workflows_reviewed: ['terraform'], unresolved_challenges: [] } };
  };
}

function scripted({ coordinator, reviews, analyzer, generator, writer }) {
  return createScriptedClient({
    coordinator,
    analyzer: analyzer || (() => JSON.stringify(F.tfAnalysis)),
    generator: generator || (() => JSON.stringify(F.tfRemediation)),
    reviewer: (prompt, n) => JSON.stringify(reviews[Math.min(n, reviews.length) - 1]),
    writer: writer || (() => JSON.stringify(F.writerOutput())),
  });
}

test('coordinator re-invokes the sub-agent with reviewer challenges, then a gate overrides APPROVE on a production destructive change', async () => {
  const dir = F.tmpDir();
  const client = scripted({
    coordinator: terraformPolicy({ finalDisposition: 'APPROVE' }),
    reviews: [F.review('REVISE', [F.challenge()]), F.review('APPROVE', [])],
  });
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });

  // The coordinator (not harness code) chose to re-run remediate with the challenge as context.
  const generatorPrompts = client.calls.filter((c) => !c.tools && /Reviewer challenges to address/.test(c.messages[0].content));
  assert.strictEqual(generatorPrompts.length, 2, 'remediation ran twice');
  assert.match(generatorPrompts[1].messages[0].content, /create_before_destroy does not help when the cluster identifier is fixed/);
  assert.doesNotMatch(generatorPrompts[0].messages[0].content, /create_before_destroy does not help/);
  assert.strictEqual(run.workflows.terraform.reviews.length, 2, 'it re-reviewed after the revision');

  // Coordinator said APPROVE; deterministic gates say a human must decide.
  assert.strictEqual(run.coordinator.disposition.disposition, 'APPROVE');
  assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION');
  assert.strictEqual(run.requires_human_decision, true);
  assert.strictEqual(run.coordinator_overridden, true);
  const ids = run.gates.map((g) => g.id);
  assert.ok(ids.includes('PRODUCTION_DESTRUCTIVE') && ids.includes('CRITICAL_RISK'));
});

test('a clean non-production examination with an approving reviewer is APPROVED and the report says PASS', async () => {
  const dir = F.tmpDir();
  const iamFile = path.join(dir, 'policy.json');
  fs.writeFileSync(iamFile, F.IAM_POLICY);
  const client = createScriptedClient({
    coordinator: (results) => {
      const last = results.map((r) => r.body).pop();
      if (!last) return { tool: 'launch_iam_workflow', input: { step: 'analyze' } };
      if (last.step === 'analyze') return { tool: 'launch_adversarial_reviewer', input: { workflow: 'iam' } }; // nothing to remediate: skip remediate
      if (last.step === 'review') return { tool: 'launch_final_review_writer', input: { coordinator_notes: 'Clean policy, reviewer approved.' } };
      return { final: { disposition: 'APPROVE', rationale: 'Reviewer approved a clean policy.', workflows_reviewed: ['iam'], unresolved_challenges: [] } };
    },
    analyzer: () => JSON.stringify(F.iamClean),
    reviewer: () => JSON.stringify(F.review('APPROVE', [], { verified_claims: ['Statement grants only s3:GetObject'] })),
    writer: () => JSON.stringify({ executive_summary: 'A tidy least-privilege policy. Nicely done.', sections: { iam: 'The policy grants only `s3:GetObject`, which matches what the reviewer found.' } }),
  });
  const run = await runExamination({ inputFile: iamFile, environment: 'non-production', client, resultsDir: dir });
  assert.strictEqual(run.final_status, 'APPROVED');
  assert.strictEqual(run.requires_human_decision, false);
  assert.deepStrictEqual(run.gates, []);
  assert.strictEqual(run.workflow_status.iam, 'PASS');
  const report = fs.readFileSync(path.join(dir, run.correlation_id, 'report.md'), 'utf8');
  assert.match(report, /^# Infrastructure Review Report: PASS$/m);
  assert.match(report, /^## IAM Policy Audit: PASS$/m);
});

test('a skipped adversarial review fails closed: the writer is refused and a gate fires', async () => {
  const dir = F.tmpDir();
  const client = createScriptedClient({
    coordinator: (results) => {
      const last = results.map((r) => r.body).pop();
      if (!last) return { tool: 'launch_terraform_workflow', input: { step: 'analyze' } };
      if (last.step === 'analyze') return { tool: 'launch_final_review_writer', input: { coordinator_notes: 'skipping review' } };
      return { final: { disposition: 'APPROVE', rationale: 'looks fine', workflows_reviewed: ['terraform'], unresolved_challenges: [] } };
    },
    analyzer: () => JSON.stringify({ destructive_changes: [], security_exposure: [], cost_notes: [], risk_level: 'LOW' }),
    generator: () => '', reviewer: () => '', writer: () => '',
  });
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'non-production', client, resultsDir: dir });
  const refused = fs.readFileSync(path.join(dir, run.correlation_id, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).find((e) => e.type === 'tool_result' && e.tool === 'launch_final_review_writer');
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error_code, 'PRECONDITION_FAILED');
  assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION');
  assert.ok(run.gates.some((g) => g.id === 'NO_ADVERSARIAL_REVIEW'));
  assert.strictEqual(run.coordinator_overridden, true);
});

test('the revision cap is enforced and surfaced to the coordinator as a structured error', async () => {
  const dir = F.tmpDir();
  const client = scripted({
    coordinator: (results) => {
      const bodies = results.map((r) => r.body);
      const last = bodies[bodies.length - 1];
      if (!last) return { tool: 'launch_terraform_workflow', input: { step: 'analyze' } };
      if (last.step === 'analyze') return { tool: 'launch_terraform_workflow', input: { step: 'remediate' } };
      if (last.ok === false && last.error.code === 'REVISION_CAP_REACHED') return { final: { disposition: 'ESCALATE', rationale: 'cap reached, challenges unresolved', workflows_reviewed: ['terraform'], unresolved_challenges: ['C1'] } };
      // keep re-invoking with challenges regardless, to hit the cap
      return { tool: 'launch_terraform_workflow', input: { step: 'remediate', challenges: [{ target: 'aws_rds_cluster.prod', claim: 'still wrong' }] } };
    },
    reviews: [F.review('REVISE', [F.challenge()])],
  });
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });
  const events = fs.readFileSync(path.join(dir, run.correlation_id, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const cap = events.find((e) => e.type === 'tool_result' && e.error_code === 'REVISION_CAP_REACHED');
  assert.ok(cap, 'cap error returned to the coordinator');
  assert.strictEqual(run.coordinator.disposition.disposition, 'ESCALATE');
  assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION');
});

test('an input that does not match the workflow gets INPUT_TYPE_MISMATCH with no model call spent', async () => {
  const dir = F.tmpDir();
  const client = createScriptedClient({
    coordinator: (results) => {
      const last = results.map((r) => r.body).pop();
      if (!last) return { tool: 'launch_kubernetes_workflow', input: { step: 'analyze' } }; // wrong workflow for a Terraform plan
      return { final: { disposition: 'ESCALATE', rationale: 'input type mismatch', workflows_reviewed: ['kubernetes'], unresolved_challenges: [] } };
    },
    analyzer: () => { throw new Error('analyzer must not be called'); },
  });
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });
  const noModelCalls = client.calls.filter((c) => !(c.tools && c.tools.some((t) => t.name.startsWith('launch_'))));
  assert.strictEqual(noModelCalls.length, 0, 'only coordinator turns reached the model');
  assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION');
});
