// Adversarial review in its own context, with file access to verify claims.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runExamination } = require('../workflow/coordinator');
const { createScriptedClient } = require('./helpers/scripted-client');
const F = require('./helpers/fixtures');

const readEvents = (dir, cid) => fs.readFileSync(path.join(dir, cid, 'audit.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const isReviewer = (c) => c.tools && c.tools.some((t) => t.name === 'read_file');

// analyze -> remediate -> review -> (review again) -> stop
function reviewTwice() {
  return (results) => {
    const last = results.map((r) => r.body).pop();
    if (!last) return { tool: 'launch_terraform_workflow', input: { step: 'analyze' } };
    if (last.step === 'analyze') return { tool: 'launch_terraform_workflow', input: { step: 'remediate' } };
    if (last.step === 'remediate') return { tool: 'launch_adversarial_reviewer', input: { workflow: 'terraform' } };
    if (last.step === 'review' && results.length < 4) return { tool: 'launch_adversarial_reviewer', input: { workflow: 'terraform' } };
    return { final: { disposition: 'ESCALATE', rationale: 'done', workflows_reviewed: ['terraform'], unresolved_challenges: [] } };
  };
}
const base = (over) => createScriptedClient({
  coordinator: reviewTwice(),
  analyzer: () => JSON.stringify(F.tfAnalysis),
  generator: () => JSON.stringify(F.tfRemediation),
  reviewer: () => JSON.stringify(F.review('ESCALATE', [F.challenge({ requires_human_signoff: true })])),
  writer: () => JSON.stringify(F.writerOutput()),
  ...over,
});

test('each review is a fresh API call whose message history holds only the review assignment', async () => {
  const dir = F.tmpDir();
  const client = base();
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });

  const firstTurns = client.calls.filter((c) => isReviewer(c) && c.messages.length === 1);
  assert.strictEqual(firstTurns.length, 2, 'two reviews, each started from a one-message history');
  for (const c of firstTurns) {
    const text = JSON.stringify(c);
    assert.ok(!text.includes('Begin the examination.'), 'no coordinator history');
    assert.ok(!text.includes('You are the coordinator'), 'no coordinator prompt');
    assert.ok(!text.includes('Reviewer challenges to reconsider'), 'no analyzer prompt/history');
    assert.ok(!text.includes('Reviewer challenges to address'), 'no generator prompt/history');
    assert.deepStrictEqual(c.tools.map((t) => t.name), ['read_file'], 'its only tool is read_file');
    assert.ok(!c.system, 'no shared system prompt');
  }
  const reviews = run.workflows.terraform.reviews;
  assert.strictEqual(reviews.length, 2);
  assert.notStrictEqual(reviews[0].context_id, reviews[1].context_id, 'a distinct context per review');
  assert.ok(reviews.every((r) => r.isolated_context === true));
  const started = readEvents(dir, run.correlation_id).filter((e) => e.type === 'reviewer_context_started');
  assert.strictEqual(started.length, 2);
  assert.ok(started.every((e) => e.isolated_context === true && e.initial_message_count === 1));
});

test('the reviewer reads the source file and its file-quoted evidence is verified against it', async () => {
  const dir = F.tmpDir();
  const run = await runExamination({
    inputFile: F.TF_PLAN, environment: 'production',
    client: base({ reviewer: () => JSON.stringify(F.review('ESCALATE', [F.challenge({ requires_human_signoff: true }), F.challenge({ id: 'C2', evidence: 'this quote was invented by the reviewer', requires_human_signoff: true })])) }),
    resultsDir: dir,
  });
  const r = run.workflows.terraform.reviews[0];
  assert.ok(r.file_reads >= 1);
  assert.deepStrictEqual(r.evidence_check.unverified, ['C2'], 'the invented quote is caught');
  assert.strictEqual(r.evidence_check.verified, 1);
  const report = fs.readFileSync(path.join(dir, run.correlation_id, 'report.md'), 'utf8');
  assert.match(report, /yes \(quoted from file\)/);
  assert.match(report, /NO \(quote not found in file\)/);
  const reads = readEvents(dir, run.correlation_id).filter((e) => e.type === 'tool_call' && e.tool === 'read_file');
  assert.ok(reads.length >= 2 && reads.every((e) => e.ok && e.agent === 'adversarial_reviewer'));
});

test('read_file is jailed to the declared input file; a reviewer that never reads it is rejected', async () => {
  const dir = F.tmpDir();
  const client = base({ reviewerPath: '/etc/passwd' });
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });
  const events = readEvents(dir, run.correlation_id);
  const reads = events.filter((e) => e.type === 'tool_call');
  assert.ok(reads.length && reads.every((e) => e.ok === false && e.error === 'PATH_NOT_ALLOWED'));
  const results = events.filter((e) => e.type === 'tool_result' && e.tool === 'launch_adversarial_reviewer');
  assert.ok(results.every((e) => e.ok === false && e.error_code === 'REVIEWER_DID_NOT_VERIFY'));
  assert.deepStrictEqual(run.workflows.terraform.reviews, [], 'an unverified review is never recorded');
  assert.ok(run.gates.some((g) => g.id === 'NO_ADVERSARIAL_REVIEW'));
});

test('a reviewer that skips the file entirely is rejected as REVIEWER_DID_NOT_VERIFY', async () => {
  const dir = F.tmpDir();
  const client = base({ reviewerReadsFile: false });
  const run = await runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir });
  assert.deepStrictEqual(run.workflows.terraform.reviews, []);
  const e = readEvents(dir, run.correlation_id).find((x) => x.type === 'tool_result' && x.tool === 'launch_adversarial_reviewer');
  assert.strictEqual(e.error_code, 'REVIEWER_DID_NOT_VERIFY');
});
