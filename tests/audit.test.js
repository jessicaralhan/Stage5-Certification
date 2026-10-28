// Audit trail: per-step model/token/cost, correlation id, persisted to disk as it happens.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runExamination } = require('../workflow/coordinator');
const { summarizeAudit, readAudit } = require('../workflow/audit');
const { calculateCost, resolveModel } = require('../workflow/config');
const { createScriptedClient } = require('./helpers/scripted-client');
const F = require('./helpers/fixtures');

function fullRun(dir, over = {}) {
  const client = createScriptedClient({
    coordinator: (results) => {
      const last = results.map((r) => r.body).pop();
      if (!last) return { tool: 'launch_terraform_workflow', input: { step: 'analyze' } };
      if (last.step === 'analyze') return { tool: 'launch_terraform_workflow', input: { step: 'remediate' } };
      if (last.step === 'remediate') return { tool: 'launch_adversarial_reviewer', input: { workflow: 'terraform' } };
      if (last.step === 'review') return { tool: 'launch_final_review_writer', input: { coordinator_notes: 'n' } };
      return { final: { disposition: 'ESCALATE', rationale: 'prod replacement', workflows_reviewed: ['terraform'], unresolved_challenges: [] } };
    },
    analyzer: () => JSON.stringify(F.tfAnalysis), generator: () => JSON.stringify(F.tfRemediation),
    reviewer: () => JSON.stringify(F.review('ESCALATE', [F.challenge({ requires_human_signoff: true })])), writer: () => JSON.stringify(F.writerOutput()),
    ...over,
  });
  return runExamination({ inputFile: F.TF_PLAN, environment: 'production', client, resultsDir: dir }).then((run) => ({ run, client }));
}

test('every model call is on disk with agent, step, model, tokens and cost, under one correlation id, and covers every agent', async () => {
  const dir = F.tmpDir();
  const { run, client } = await fullRun(dir);
  const events = readAudit(path.join(dir, run.correlation_id, 'audit.jsonl'));
  assert.ok(events.every((e) => e.correlation_id === run.correlation_id));
  assert.deepStrictEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), 'strictly ordered');
  const calls = events.filter((e) => e.type === 'llm_call');
  assert.strictEqual(calls.length, client.calls.length, 'every model call, coordinator turns and reviewer turns included, is recorded');
  for (const c of calls) {
    assert.ok(c.agent && c.step && c.context_id);
    assert.strictEqual(typeof c.requested_model, 'string');
    assert.strictEqual(typeof c.model, 'string');
    assert.ok(c.input_tokens > 0 && c.output_tokens > 0);
    assert.strictEqual(c.total_tokens, c.input_tokens + c.output_tokens);
    assert.strictEqual(c.cost_usd, calculateCost(c.requested_model, c.input_tokens, c.output_tokens));
    assert.strictEqual(c.pricing_verified, false, 'unverified rates are flagged, not hidden');
  }
  const agents = new Set(calls.map((c) => c.agent));
  for (const a of ['coordinator', 'terraform_workflow', 'adversarial_reviewer', 'final_review_writer']) assert.ok(agents.has(a), `${a} is in the audit trail`);
  const coordinatorTurns = calls.filter((c) => c.agent === 'coordinator');
  assert.strictEqual(coordinatorTurns.length, run.coordinator.turns, 'all coordinator turns are costed, not just one');
});

test('totals in run.json and the report are computed from the persisted file and match it', async () => {
  const dir = F.tmpDir();
  const { run } = await fullRun(dir);
  const summary = summarizeAudit(path.join(dir, run.correlation_id, 'audit.jsonl'));
  assert.deepStrictEqual(run.audit_summary, summary);
  const sumTokens = readAudit(path.join(dir, run.correlation_id, 'audit.jsonl')).filter((e) => e.type === 'llm_call').reduce((t, e) => t + e.total_tokens, 0);
  assert.strictEqual(summary.total_tokens, sumTokens);
  const report = fs.readFileSync(path.join(dir, run.correlation_id, 'report.md'), 'utf8');
  assert.match(report, new RegExp(`${summary.llm_calls} model calls`));
  assert.ok(summary.by_agent['final_review_writer'], 'the report writer cost is included (the old audit trail omitted it)');
});

test('the audit trail survives a crash: events written before a failure are on disk and the run fails closed', async () => {
  const dir = F.tmpDir();
  let n = 0;
  const { run } = await fullRun(dir, {
    reviewer: () => { n += 1; throw new Error('boom: model unavailable'); },
  }).catch(() => ({ run: null }));
  // The scripted client throws inside the reviewer; the harness must still finish and persist.
  assert.ok(n >= 1);
  const [cid] = fs.readdirSync(dir);
  const events = readAudit(path.join(dir, cid, 'audit.jsonl'));
  assert.ok(events.some((e) => e.type === 'examination_started'));
  assert.ok(events.some((e) => e.type === 'llm_call' && e.agent === 'coordinator'));
  assert.ok(events.some((e) => e.type === 'sub_agent_exception' || e.type === 'tool_result'));
  const stored = JSON.parse(fs.readFileSync(path.join(dir, cid, 'run.json'), 'utf8'));
  assert.strictEqual(stored.final_status, 'PENDING_HUMAN_DECISION');
});

test('an unknown model fails fast at startup instead of recording an unpriced cost', () => {
  const old = process.env.STAGE5_MODEL;
  process.env.STAGE5_MODEL = 'claude-not-priced';
  assert.throws(() => resolveModel(), /no entry in workflow\/config\.js PRICING/);
  if (old === undefined) delete process.env.STAGE5_MODEL; else process.env.STAGE5_MODEL = old;
  assert.throws(() => calculateCost('claude-not-priced', 1, 1), /unpriced/);
});
