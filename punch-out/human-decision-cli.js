#!/usr/bin/env node
// Human decision interface for the punch-out checkpoint.
//
//   node punch-out/human-decision-cli.js list
//   node punch-out/human-decision-cli.js show   <correlation_id>
//   node punch-out/human-decision-cli.js status <correlation_id>
//   node punch-out/human-decision-cli.js decide <correlation_id> --decision continue|reject --reviewer "Name" [--notes "..."]
//
// `decide` without flags prompts interactively. Decisions are appended to
// results/<correlation_id>/decisions.jsonl and never edited or removed; the
// system's own report.md and run.json are left untouched.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { appendDecision, readDecisions, effectiveStatus, loadRun, DEFAULT_RESULTS_DIR } = require('./decisions');

const resultsDir = process.env.STAGE5_RESULTS_DIR || DEFAULT_RESULTS_DIR;

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return flags;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()); }));
}

function listRuns() {
  if (!fs.existsSync(resultsDir)) return [];
  return fs.readdirSync(resultsDir).filter((d) => fs.existsSync(path.join(resultsDir, d, 'run.json')));
}

function cmdList() {
  const pending = listRuns().map((cid) => effectiveStatus(cid, resultsDir)).filter((s) => s.effective_status === 'PENDING_HUMAN_DECISION');
  console.log('\n=== Examinations awaiting a human decision ===\n');
  if (!pending.length) return console.log('None.\n');
  for (const p of pending) {
    const run = loadRun(p.correlation_id, resultsDir);
    console.log(`${p.correlation_id}  (${run.environment}, ${run.input.name})`);
    run.final_status_reasons.slice(0, 3).forEach((r) => console.log(`    - ${r}`));
  }
  console.log(`\nTotal pending: ${pending.length}\n`);
}

function cmdShow(cid) {
  const run = loadRun(cid, resultsDir);
  console.log(`\nCorrelation ID : ${cid}\nInput          : ${run.input.name}\nEnvironment    : ${run.environment}\nSystem status  : ${run.final_status}`);
  console.log('Reasons:');
  run.final_status_reasons.forEach((r) => console.log(`  - ${r}`));
  console.log(`\nFull report: results/${cid}/report.md\n`);
}

function cmdStatus(cid) {
  const s = effectiveStatus(cid, resultsDir);
  console.log(`\n${cid}\n  system status   : ${s.system_status}\n  effective status: ${s.effective_status}`);
  s.decisions.forEach((d) => console.log(`  - ${d.timestamp} ${d.decision.toUpperCase()} by ${d.reviewer}${d.notes ? ` (${d.notes})` : ''} [${d.decision_id}]`));
  console.log('');
}

async function cmdDecide(cid, flags) {
  cmdShow(cid);
  let reviewer = flags.reviewer || process.env.HUMAN_REVIEWER;
  let decision = flags.decision;
  let notes = flags.notes === true ? '' : flags.notes;
  if (!reviewer) reviewer = await ask('Your name (recorded in the audit trail): ');
  if (!decision) decision = (await ask('Decision (continue / reject): ')).toLowerCase();
  if (notes === undefined) notes = await ask('Notes (optional): ');
  const entry = appendDecision({ correlationId: cid, decision, reviewer, notes, resultsDir });
  console.log(`Recorded ${entry.decision.toUpperCase()} by ${entry.reviewer} at ${entry.timestamp}`);
  console.log(`  decision id : ${entry.decision_id}${entry.supersedes ? ` (supersedes ${entry.supersedes})` : ''}`);
  console.log(`  report sha  : ${entry.report_sha256}`);
  console.log(`  notes       : ${entry.notes || '(none)'}\n`);
}

async function main() {
  const [cmd, cid, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (cmd === 'list' || cmd === undefined) return cmdList();
  if (!cid) throw new Error(`usage: ${cmd} <correlation_id>`);
  if (cmd === 'show') return cmdShow(cid);
  if (cmd === 'status') return cmdStatus(cid);
  if (cmd === 'decide') return cmdDecide(cid, flags);
  throw new Error(`unknown command "${cmd}". Use list | show | status | decide`);
}

if (require.main === module) {
  main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
}

module.exports = { parseFlags };
