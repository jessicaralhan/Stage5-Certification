#!/usr/bin/env node
// CLI entry point.
//   node workflow/coordinator-harness.js <input_file> [production|non-production]
//
// The input file is handed to the coordinator only as a name, extension and
// size. The coordinator dispatches sub-agents; it never reads the file.

try { require('dotenv').config(); } catch (e) { /* dotenv is optional; the key may already be in the environment */ }

const { runExamination } = require('./coordinator');

async function main() {
  const [inputFile, environment = 'non-production'] = process.argv.slice(2);
  if (!inputFile) {
    process.stdout.write('Usage: node workflow/coordinator-harness.js <input_file> [production|non-production]\n');
    process.exit(1);
  }
  const run = await runExamination({ inputFile, environment });
  const out = (s) => process.stdout.write(s + '\n');
  out(`\nCorrelation ID : ${run.correlation_id}`);
  out(`Workflows      : ${Object.keys(run.workflow_status).map((w) => `${w}=${run.workflow_status[w]}`).join(', ') || 'none'}`);
  out(`Final status   : ${run.final_status}`);
  if (run.coordinator_overridden) out('Note           : coordinator APPROVE was overridden by a deterministic gate');
  run.final_status_reasons.forEach((r) => out(`  - ${r}`));
  out(`Model calls    : ${run.audit_summary.llm_calls}, ${run.audit_summary.total_tokens} tokens, $${run.audit_summary.total_cost_usd.toFixed(6)}`);
  out(`Report         : ${run.files.report}`);
  out(`Audit trail    : ${run.files.audit}`);
  if (run.requires_human_decision) {
    out(`\nHuman decision required:\n  node punch-out/human-decision-cli.js decide ${run.correlation_id} --decision continue|reject --reviewer "Your Name"`);
  }
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(2);
});
