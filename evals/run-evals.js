#!/usr/bin/env node
// Stage 3 eval runner for every agent in the delegation system.
//
//   node evals/run-evals.js                    run all evals against the live model
//   node evals/run-evals.js --only terraform   run one (comma-separate for several)
//   node evals/run-evals.js --min-pass-rate 0.95
//
// For each eval it runs the real sub-agent code path (same prompts, same schema
// validation, same client as production) on the eval's cases, scores every
// named criterion, and writes MEASURED results to
//   evals/results/<eval_id>.results.json      per-case, per-criterion results
//   evals/results/audit/<eval_id>-<ts>.jsonl  per-call model/tokens/cost
//   evals/results/SUMMARY.md                  one table across all evals
// Results are never hand-edited; they exist only because a run produced them.

try { require('dotenv').config(); } catch (e) { /* optional */ }

const fs = require('fs');
const path = require('path');
const { liveClient } = require('../workflow/anthropic-client');
const { resolveModel } = require('../workflow/config');
const { AuditTrail, summarizeAudit } = require('../workflow/audit');
const { EVALS } = require('./definitions');

const ROOT = path.join(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');

function buildEnv({ client, model, manifest, audit }) {
  const rawTexts = [];
  const capturing = {
    callMessages: async (req) => {
      const resp = await client.callMessages(req);
      if (!req.tools) rawTexts.push(resp.text);
      return resp;
    },
  };
  return {
    rawTexts: () => rawTexts.slice(),
    makeContext: ({ inputFile, environment }) => ({
      client: capturing, model, manifest, rootDir: ROOT, audit, environment,
      inputFile: path.resolve(inputFile), inputName: path.basename(inputFile),
      state: {}, finalReview: null, artifactSeq: 0, revisions: {}, dispatches: 0, turns: 0,
    }),
  };
}

function scoreCriterion(criterion, result) {
  try {
    const r = criterion.check(result);
    return { name: criterion.name, pass: Boolean(r.pass), detail: r.detail };
  } catch (e) {
    return { name: criterion.name, pass: false, detail: `check could not run: ${e.message}` };
  }
}

async function runEval(def, { client, model, manifest, auditDir, stamp }) {
  const audit = new AuditTrail({ correlationId: `eval-${def.id}-${stamp}`, dir: auditDir });
  const caseResults = [];
  for (const c of def.cases) {
    const env = buildEnv({ client, model, manifest, audit });
    let result;
    let error = null;
    try {
      result = await c.run(env);
    } catch (e) {
      error = e.message;
      result = {};
    }
    const criteria = c.criteria.map((k) => (error ? { name: k.name, pass: false, detail: `case failed to run: ${error}` } : scoreCriterion(k, result)));
    caseResults.push({ id: c.id, description: c.description, input: c.input, environment: c.environment, error, criteria });
  }

  const byName = {};
  for (const cr of caseResults) for (const k of cr.criteria) {
    const a = (byName[k.name] = byName[k.name] || { name: k.name, passed: 0, total: 0 });
    a.total += 1;
    if (k.pass) a.passed += 1;
  }
  const criteria = Object.values(byName).map((a) => ({ ...a, pass_rate: Number((a.passed / a.total).toFixed(3)) }));
  const passed = criteria.reduce((t, a) => t + a.passed, 0);
  const total = criteria.reduce((t, a) => t + a.total, 0);
  const summary = summarizeAudit(audit.file);
  return {
    eval_id: def.id,
    agent: def.workflow,
    title: def.title,
    prompts: def.prompts,
    run_at: new Date().toISOString(),
    model: { requested: model, reported_by_api: summary.models_reported_by_api },
    cases: caseResults,
    criteria,
    named_criteria: criteria.length,
    overall: { passed, total, pass_rate: total ? Number((passed / total).toFixed(3)) : 0 },
    usage: { llm_calls: summary.llm_calls, input_tokens: summary.total_input_tokens, output_tokens: summary.total_output_tokens, cost_usd: summary.total_cost_usd, pricing_verified: summary.pricing_verified },
    audit_file: path.relative(ROOT, audit.file),
  };
}

function summaryMarkdown(all, minRate) {
  let md = `# Stage 3 eval results\n\nGenerated ${new Date().toISOString()} by \`node evals/run-evals.js\`. Every number below was produced by a run; nothing here is hand-written.\n\n`;
  md += '| Agent | Prompts | Cases | Named criteria | Checks passed | Pass rate | Model | Cost (USD) |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n';
  for (const r of all) md += `| ${r.agent} | ${r.prompts.join(', ')} | ${r.cases.length} | ${r.named_criteria} | ${r.overall.passed}/${r.overall.total} | ${(r.overall.pass_rate * 100).toFixed(0)}% | ${r.model.reported_by_api.join(', ')} | ${r.usage.cost_usd.toFixed(6)} |\n`;
  md += `\nTarget pass rate per agent: ${(minRate * 100).toFixed(0)}%. Per-criterion rates and failure details are in each \`<agent>.results.json\`.\n`;
  const failing = all.flatMap((r) => r.cases.flatMap((c) => c.criteria.filter((k) => !k.pass).map((k) => `- ${r.agent} / ${c.id} / ${k.name}: ${k.detail}`)));
  md += failing.length ? `\n## Failing checks\n\n${failing.join('\n')}\n` : '\nNo failing checks.\n';
  return md;
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const only = flag('only') ? flag('only').split(',') : null;
  const minRate = Number(flag('min-pass-rate') || 0.95);
  const selected = EVALS.filter((e) => !only || only.includes(e.id));
  if (!selected.length) throw new Error(`no eval matches --only ${only}`);

  const model = resolveModel();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents.manifest.json'), 'utf8'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(path.join(RESULTS_DIR, 'audit'), { recursive: true });

  const all = [];
  for (const def of selected) {
    process.stdout.write(`\n=== eval: ${def.id} (${def.cases.length} cases) ===\n`);
    const result = await runEval(def, { client: liveClient, model, manifest, auditDir: path.join(RESULTS_DIR, 'audit', `${def.id}-${stamp}`), stamp });
    fs.writeFileSync(path.join(RESULTS_DIR, `${def.id}.results.json`), JSON.stringify(result, null, 2));
    all.push(result);
    for (const c of result.cases) for (const k of c.criteria) process.stdout.write(`  ${k.pass ? 'PASS' : 'FAIL'}  ${c.id} / ${k.name}${k.pass ? '' : `  -> ${k.detail}`}\n`);
    process.stdout.write(`  ${result.overall.passed}/${result.overall.total} (${(result.overall.pass_rate * 100).toFixed(0)}%), $${result.usage.cost_usd.toFixed(6)}\n`);
  }
  if (!only) fs.writeFileSync(path.join(RESULTS_DIR, 'SUMMARY.md'), summaryMarkdown(all, minRate));
  const below = all.filter((r) => r.overall.pass_rate < minRate);
  if (below.length) {
    process.stdout.write(`\nBelow the ${(minRate * 100).toFixed(0)}% target: ${below.map((r) => r.agent).join(', ')}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => { process.stderr.write(`Fatal: ${e.message}\n`); process.exit(2); });
}

module.exports = { runEval, buildEnv, scoreCriterion, summaryMarkdown };
