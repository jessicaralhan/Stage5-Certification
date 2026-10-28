// Human decision ledger: append-only, identity-stamped.
//
// A run that hits a human checkpoint stays PENDING_HUMAN_DECISION until a
// person records Continue or Reject here. The system's own report is retained
// verbatim; the ledger stores its SHA-256 so a decision is tied to exactly the
// report the human saw. Decisions are only ever appended: changing your mind
// appends a new entry that supersedes the earlier one, and earlier lines are
// never edited or deleted.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveFinalStatus } = require('../workflow/gates');

const DEFAULT_RESULTS_DIR = path.join(__dirname, '..', 'results');
const DECISIONS_FILE = 'decisions.jsonl';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function runDir(resultsDir, cid) {
  if (!/^[A-Za-z0-9._-]+$/.test(cid)) throw new Error(`invalid correlation id: ${cid}`);
  return path.join(resultsDir, cid);
}

function loadRun(cid, resultsDir = DEFAULT_RESULTS_DIR) {
  const file = path.join(runDir(resultsDir, cid), 'run.json');
  if (!fs.existsSync(file)) throw new Error(`no run record for ${cid} (${file})`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readDecisions(cid, resultsDir = DEFAULT_RESULTS_DIR) {
  const file = path.join(runDir(resultsDir, cid), DECISIONS_FILE);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function appendDecision({ correlationId, decision, reviewer, notes = '', resultsDir = DEFAULT_RESULTS_DIR }) {
  if (!['continue', 'reject'].includes(decision)) throw new Error('decision must be "continue" or "reject"');
  if (!reviewer || !String(reviewer).trim()) throw new Error('a named reviewer identity is required for every decision');
  const run = loadRun(correlationId, resultsDir);
  if (!run.requires_human_decision) throw new Error(`run ${correlationId} has no pending human checkpoint (final_status ${run.final_status})`);

  const dir = runDir(resultsDir, correlationId);
  const reportFile = path.join(dir, 'report.md');
  const prior = readDecisions(correlationId, resultsDir);
  const entry = {
    decision_id: `${correlationId}#${prior.length + 1}`,
    correlation_id: correlationId,
    decision,
    reviewer: String(reviewer).trim(),
    notes: String(notes || ''),
    timestamp: new Date().toISOString(),
    report_sha256: fs.existsSync(reportFile) ? sha256(fs.readFileSync(reportFile)) : null,
    system_status_at_decision: run.final_status,
    supersedes: prior.length ? prior[prior.length - 1].decision_id : null,
  };
  fs.appendFileSync(path.join(dir, DECISIONS_FILE), JSON.stringify(entry) + '\n'); // append-only
  return entry;
}

function effectiveStatus(cid, resultsDir = DEFAULT_RESULTS_DIR) {
  const run = loadRun(cid, resultsDir);
  const decisions = readDecisions(cid, resultsDir);
  return { correlation_id: cid, system_status: run.final_status, effective_status: resolveFinalStatus(run, decisions), decisions };
}

module.exports = { appendDecision, readDecisions, effectiveStatus, loadRun, sha256, DEFAULT_RESULTS_DIR };
