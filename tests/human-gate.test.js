// Punch-outs are honored: no auto-approval past a human checkpoint, and the human
// decision is append-only, identity-stamped, and leaves the system report untouched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process'); // tests are exempt from the no-CLI-runtime rule
const { runExamination } = require('../workflow/coordinator');
const { appendDecision, readDecisions, effectiveStatus, sha256 } = require('../punch-out/decisions');
const { createScriptedClient } = require('./helpers/scripted-client');
const F = require('./helpers/fixtures');

async function pendingRun(dir) {
  const client = createScriptedClient({
    coordinator: (results) => {
      const last = results.map((r) => r.body).pop();
      if (!last) return { tool: 'launch_terraform_workflow', input: { step: 'analyze' } };
      if (last.step === 'analyze') return { tool: 'launch_terraform_workflow', input: { step: 'remediate' } };
      if (last.step === 'remediate') return { tool: 'launch_adversarial_reviewer', input: { workflow: 'terraform' } };
      if (last.step === 'review') return { tool: 'launch_final_review_writer', input: { coordinator_notes: 'approving' } };
      return { final: { disposition: 'APPROVE', rationale: 'the coordinator tries to approve', workflows_reviewed: ['terraform'], unresolved_challenges: [] } };
    },
    analyzer: () => JSON.stringify(F.tfAnalysis), generator: () => JSON.stringify(F.tfRemediation),
    reviewer: () => JSON.stringify(F.review('APPROVE', [])), writer: () => JSON.stringify(F.writerOutput()),
  });
  return runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });
}

test('the coordinator cannot approve past a human checkpoint, even when the reviewer also approved', async () => {
  const dir = F.tmpDir();
  const run = await pendingRun(dir);
  assert.strictEqual(run.coordinator.disposition.disposition, 'APPROVE');
  assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION');
  assert.strictEqual(effectiveStatus(run.correlation_id, dir).effective_status, 'PENDING_HUMAN_DECISION');
});

test('decisions are append-only, carry the reviewer identity and notes, and never alter the system report', async () => {
  const dir = F.tmpDir();
  const run = await pendingRun(dir);
  const cid = run.correlation_id;
  const reportFile = path.join(dir, cid, 'report.md');
  const runFile = path.join(dir, cid, 'run.json');
  const reportBefore = fs.readFileSync(reportFile);
  const runBefore = fs.readFileSync(runFile);

  const first = appendDecision({ correlationId: cid, decision: 'reject', reviewer: 'Pat Reviewer', notes: 'Needs a maintenance window first.', resultsDir: dir });
  const ledgerAfterFirst = fs.readFileSync(path.join(dir, cid, 'decisions.jsonl'), 'utf8');
  assert.strictEqual(effectiveStatus(cid, dir).effective_status, 'HUMAN_REJECTED');
  assert.strictEqual(first.reviewer, 'Pat Reviewer');
  assert.strictEqual(first.notes, 'Needs a maintenance window first.');
  assert.strictEqual(first.report_sha256, sha256(reportBefore), 'bound to exactly the report the human saw');

  const second = appendDecision({ correlationId: cid, decision: 'continue', reviewer: 'Sam Lead', notes: 'Window booked.', resultsDir: dir });
  const ledger = fs.readFileSync(path.join(dir, cid, 'decisions.jsonl'), 'utf8');
  assert.ok(ledger.startsWith(ledgerAfterFirst), 'the earlier line is byte-for-byte unchanged');
  assert.strictEqual(readDecisions(cid, dir).length, 2, 'both decisions are retained');
  assert.strictEqual(second.supersedes, first.decision_id);
  assert.strictEqual(effectiveStatus(cid, dir).effective_status, 'HUMAN_CONTINUE');

  assert.ok(reportBefore.equals(fs.readFileSync(reportFile)), 'system report retained verbatim');
  assert.ok(runBefore.equals(fs.readFileSync(runFile)), 'run record untouched');
});

test('a decision needs a named reviewer, a valid choice, and an actual pending checkpoint', async () => {
  const dir = F.tmpDir();
  const run = await pendingRun(dir);
  assert.throws(() => appendDecision({ correlationId: run.correlation_id, decision: 'continue', reviewer: '  ', resultsDir: dir }), /named reviewer/);
  assert.throws(() => appendDecision({ correlationId: run.correlation_id, decision: 'maybe', reviewer: 'A', resultsDir: dir }), /continue|reject/);
  assert.throws(() => appendDecision({ correlationId: '../etc', decision: 'continue', reviewer: 'A', resultsDir: dir }), /invalid correlation id/);
  assert.strictEqual(readDecisions(run.correlation_id, dir).length, 0);
});

test('the CLI persists notes (regression: the old CLI dropped them) and lists the run as pending until decided', async () => {
  const dir = F.tmpDir();
  const run = await pendingRun(dir);
  const cli = path.join(F.ROOT, 'punch-out', 'human-decision-cli.js');
  const env = { ...process.env, STAGE5_RESULTS_DIR: dir };
  const before = spawnSync('node', [cli, 'list'], { env, encoding: 'utf8' });
  assert.match(before.stdout, new RegExp(run.correlation_id));
  const done = spawnSync('node', [cli, 'decide', run.correlation_id, '--decision', 'continue', '--reviewer', 'Jo Human', '--notes', 'Reviewed with the DBA.'], { env, encoding: 'utf8' });
  assert.strictEqual(done.status, 0, done.stderr);
  const [entry] = readDecisions(run.correlation_id, dir);
  assert.strictEqual(entry.notes, 'Reviewed with the DBA.');
  assert.strictEqual(entry.reviewer, 'Jo Human');
  const after = spawnSync('node', [cli, 'list'], { env, encoding: 'utf8' });
  assert.doesNotMatch(after.stdout, new RegExp(run.correlation_id));
  const noName = spawnSync('node', [cli, 'decide', run.correlation_id, '--decision', 'reject', '--reviewer', ' '], { env, encoding: 'utf8', input: '\n' });
  assert.notStrictEqual(noName.status, 0);
});
