// Substance assessment: core / peripheral / toy, elevation routing, human gate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { evaluateSubstance } = require('../workflow/gates');
const { runExamination } = require('../workflow/coordinator');
const { createScriptedClient } = require('./helpers/scripted-client');
const F = require('./helpers/fixtures');

const doc = JSON.parse(fs.readFileSync(path.join(F.ROOT, 'substance.json'), 'utf8'));
const withCategories = (cats) => ({ workflows: doc.workflows.map((w, i) => ({ ...w, category: cats[i] })) });

test('the declared system is honestly assessed: three core workflows, one peripheral, no elevation', () => {
  const s = evaluateSubstance(doc);
  assert.deepStrictEqual(s.counts, { core: 3, peripheral: 1, toy: 0 });
  assert.strictEqual(s.elevate, false);
  for (const w of doc.workflows) {
    assert.ok(['core', 'peripheral', 'toy'].includes(w.category));
    assert.ok(w.rationale.length > 40, `${w.id} has a real rationale`);
  }
});

test('any toy workflow elevates; so do two or more peripheral; one peripheral does not', () => {
  assert.strictEqual(evaluateSubstance(withCategories(['core', 'core', 'toy', 'core'])).elevate, true);
  assert.strictEqual(evaluateSubstance(withCategories(['core', 'peripheral', 'core', 'peripheral'])).elevate, true);
  assert.strictEqual(evaluateSubstance(withCategories(['core', 'core', 'core', 'peripheral'])).elevate, false);
});

test('substance elevation blocks final disposition until a human decides, even for an otherwise clean run', async () => {
  const dir = F.tmpDir();
  const iamFile = path.join(dir, 'policy.json');
  fs.writeFileSync(iamFile, F.IAM_POLICY);
  const client = createScriptedClient({
    coordinator: (results) => {
      const last = results.map((r) => r.body).pop();
      if (!last) return { tool: 'launch_iam_workflow', input: { step: 'analyze' } };
      if (last.step === 'analyze') return { tool: 'launch_adversarial_reviewer', input: { workflow: 'iam' } };
      if (last.step === 'review') return { tool: 'launch_final_review_writer', input: { coordinator_notes: 'clean' } };
      return { final: { disposition: 'APPROVE', rationale: 'clean', workflows_reviewed: ['iam'], unresolved_challenges: [] } };
    },
    analyzer: () => JSON.stringify(F.iamClean),
    reviewer: () => JSON.stringify(F.review('APPROVE', [])),
    writer: () => JSON.stringify({ executive_summary: 'Clean policy.', sections: { iam: 'Nothing to fix in `s3:GetObject` access.' } }),
  });
  const run = await runExamination({ inputFile: iamFile, environment: 'non-production', client, resultsDir: dir, substanceDoc: withCategories(['core', 'core', 'toy', 'core']) });
  assert.deepStrictEqual(run.gates, [], 'no finding-based gate fired');
  assert.strictEqual(run.workflow_status.iam, 'PASS');
  assert.strictEqual(run.final_status, 'PENDING_HUMAN_DECISION', 'substance elevation alone blocks disposition');
  assert.ok(run.final_status_reasons.some((r) => r.includes('SUBSTANCE_ELEVATION')));
  assert.strictEqual(run.coordinator_overridden, true);
});
