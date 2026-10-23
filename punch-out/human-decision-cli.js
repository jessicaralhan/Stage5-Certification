#!/usr/bin/env node

// Human Decision Interface: CLI for approving/rejecting escalated findings

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DECISIONS_DIR = path.join(__dirname, '../results/escalations');

// Ensure escalations directory exists
if (!fs.existsSync(DECISIONS_DIR)) {
  fs.mkdirSync(DECISIONS_DIR, { recursive: true });
}

async function getUserInput(prompt) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function recordDecision(runId, decision, reviewer) {
  const decisionRecord = {
    run_id: runId,
    decision: decision, // 'continue' or 'reject'
    reviewer: reviewer,
    timestamp: new Date().toISOString(),
  };

  const decisionFile = path.join(DECISIONS_DIR, `${runId}-decision.json`);
  fs.writeFileSync(decisionFile, JSON.stringify(decisionRecord, null, 2));

  return decisionRecord;
}

async function approveEscalation(runId) {
  console.log(`\n=== Approve Escalated Run: ${runId} ===\n`);

  // Load the escalation record
  const runFile = path.join(__dirname, `../results/run-${runId}-output.json`);
  if (!fs.existsSync(runFile)) {
    console.error(`Error: Run file not found: ${runFile}`);
    process.exit(1);
  }

  const runData = JSON.parse(fs.readFileSync(runFile, 'utf-8'));

  // Display escalation reason
  console.log('Escalation Reasons:');
  if (runData.escalation_info && runData.escalation_info.reasons) {
    runData.escalation_info.reasons.forEach((reason) => {
      console.log(`  • ${reason}`);
    });
  }

  console.log('\nWorkflow Findings Summary:');
  if (runData.workflow_findings) {
    console.log(`  Risk Level: ${runData.workflow_findings.risk_level}`);
    if (runData.workflow_findings.destructive_changes) {
      console.log(`  Destructive Changes: ${runData.workflow_findings.destructive_changes.length}`);
    }
    if (runData.workflow_findings.security_issues) {
      console.log(`  Security Issues: ${runData.workflow_findings.security_issues.length}`);
    }
    if (runData.workflow_findings.access_issues) {
      console.log(`  Access Issues: ${runData.workflow_findings.access_issues.length}`);
    }
  }

  // Get reviewer name
  const reviewer = await getUserInput('\nYour name (for audit trail): ');
  if (!reviewer.trim()) {
    console.error('Reviewer name is required.');
    process.exit(1);
  }

  // Get decision
  let validDecision = false;
  let decision = '';
  while (!validDecision) {
    const input = await getUserInput(
      '\nDecision (continue=approve|reject=block): '
    );
    if (['continue', 'reject'].includes(input.toLowerCase())) {
      decision = input.toLowerCase();
      validDecision = true;
    } else {
      console.log('Invalid decision. Please enter "continue" or "reject".');
    }
  }

  // Get optional notes
  const notes = await getUserInput('Notes (optional): ');

  // Record the decision
  const record = await recordDecision(runId, decision, reviewer);
  record.notes = notes;

  console.log('\n✓ Decision recorded:');
  console.log(`  Run ID: ${runId}`);
  console.log(`  Decision: ${decision === 'continue' ? 'APPROVED' : 'REJECTED'}`);
  console.log(`  Reviewer: ${reviewer}`);
  console.log(`  Timestamp: ${record.timestamp}`);

  if (notes.trim()) {
    console.log(`  Notes: ${notes}`);
  }

  console.log(`\nDecision saved to: ${path.join(DECISIONS_DIR, `${runId}-decision.json`)}\n`);

  return record;
}

async function listEscalations() {
  console.log('\n=== Pending Escalations ===\n');

  const resultsDir = path.join(__dirname, '../results');
  if (!fs.existsSync(resultsDir)) {
    console.log('No runs found.');
    return;
  }

  const files = fs.readdirSync(resultsDir).filter((f) => f.startsWith('run-') && f.endsWith('-output.json'));

  if (files.length === 0) {
    console.log('No runs found.');
    return;
  }

  let pendingCount = 0;

  files.forEach((file) => {
    const runId = file.match(/run-(\d+)-output/)[1];
    const runFile = path.join(resultsDir, file);
    const runData = JSON.parse(fs.readFileSync(runFile, 'utf-8'));

    // Check if decision already made
    const decisionFile = path.join(DECISIONS_DIR, `${runId}-decision.json`);
    const hasDecision = fs.existsSync(decisionFile);

    if (runData.escalation_info && runData.escalation_info.should_escalate && !hasDecision) {
      pendingCount++;
      console.log(`Run ID: ${runId}`);
      console.log(`  Status: AWAITING DECISION`);
      console.log(`  Risk Level: ${runData.workflow_findings?.risk_level || 'unknown'}`);
      console.log(`  Environment: ${runData.workflow_findings?.environment || 'unknown'}`);

      if (runData.escalation_info.reasons.length > 0) {
        console.log(`  Reasons:`);
        runData.escalation_info.reasons.forEach((reason) => {
          console.log(`    • ${reason}`);
        });
      }
      console.log('');
    }
  });

  if (pendingCount === 0) {
    console.log('No pending escalations.');
  } else {
    console.log(`Total pending: ${pendingCount}`);
    console.log('\nUsage: node human-decision-cli.js approve <run_id>');
  }

  console.log('');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // List mode
    await listEscalations();
  } else if (args[0] === 'approve' && args[1]) {
    // Approve mode
    await approveEscalation(args[1]);
  } else if (args[0] === 'list') {
    // Explicit list mode
    await listEscalations();
  } else {
    console.log(`
Usage:
  node human-decision-cli.js              # List pending escalations
  node human-decision-cli.js list          # List pending escalations
  node human-decision-cli.js approve <id>  # Approve/reject a run

Examples:
  node human-decision-cli.js
  node human-decision-cli.js approve 1792577327024
`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { recordDecision, approveEscalation, listEscalations };
