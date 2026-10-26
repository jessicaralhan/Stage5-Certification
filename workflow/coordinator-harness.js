#!/usr/bin/env node

// Coordinator Harness: Multi-workflow orchestration engine
// Routes input to correct workflow, applies guardrails, returns unified report

require('dotenv').config({ override: true });

const path = require('path');
const { generateReport } = require('./report-writer-executor');
const { determineEscalation, assessSubstance } = require('./escalation-gates');
const { writeResults } = require('./results-writer');

// Workflow dispatcher tools
const WORKFLOWS = {
  terraform: './workflow/terraform-executor.js',
  kubernetes: './workflow/kubernetes-executor.js',
  iam: './workflow/iam-executor.js',
};

// Execute chosen workflow
async function executeWorkflow(workflowType, inputFile, environment, correlationId) {
  process.stdout.write(`\n[Orchestrator] Executing ${workflowType} workflow...\n`);

  // Import the appropriate workflow executor
  try {
    const executor = require(path.join(__dirname, `${workflowType}-executor.js`));
    if (!executor || typeof executor.run !== 'function') {
      throw new Error(`Executor module does not export run function`);
    }
    const result = await executor.run(inputFile, environment, correlationId);
    return result;
  } catch (err) {
    throw new Error(`Failed to execute ${workflowType} workflow: ${err.message}`);
  }
}

// Main orchestration flow
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    process.stdout.write(`
Usage: node coordinator-harness.js <input_file> <workflow_type> [environment]

Workflow types: terraform, kubernetes, iam

Examples:
  node coordinator-harness.js config.tf terraform production
  node coordinator-harness.js manifest.yaml kubernetes staging
  node coordinator-harness.js policy.json iam production
`);
    process.exit(1);
  }

  const inputFile = args[0];
  const workflowType = args[1];
  const environment = args[2] || 'non-production';

  // Validate workflow type
  if (!['terraform', 'kubernetes', 'iam'].includes(workflowType)) {
    process.stderr.write(`Error: Invalid workflow type: ${workflowType}\n`);
    process.stderr.write(`Valid types: terraform, kubernetes, iam\n`);
    process.exit(1);
  }

  process.stdout.write(`\n=== Stage 5 Coordinator: Multi-Workflow Orchestration ===\n`);
  process.stdout.write(`Input: ${inputFile}\n`);
  process.stdout.write(`Workflow: ${workflowType}\n`);
  process.stdout.write(`Environment: ${environment}\n\n`);

  const fs = require('fs');
  try {
    // Step 1: Execute the chosen workflow
    process.stdout.write(`[Step 1] Executing ${workflowType} workflow...\n`);
    const runId = `${Date.now()}`;
    const workflowResult = await executeWorkflow(workflowType, inputFile, environment, runId);

    process.stdout.write(`    ✓ Workflow complete. Risk level: ${workflowResult.risk_level}\n`);

    // Step 2: Check escalation gates
    process.stdout.write(`[Step 2] Checking escalation gates...\n`);

    const workflowFindings = {};
    workflowFindings[workflowType] = workflowResult;

    const substanceLevel = assessSubstance(workflowFindings, environment);
    const escalationInfo = determineEscalation(workflowFindings, environment);

    // Substance-based elevation:
    // Per Stage 5 spec: "If any workflow is scored toy, or two or more are peripheral, the system elevates for human review"
    // Note: In this single-workflow-per-run architecture, only the "toy" check applies.
    // The "2+ peripheral" check would require a batch evaluation system that coordinates multiple
    // concurrent workflows, which is outside the scope of this single-run coordinator.

    if (substanceLevel === 'toy') {
      escalationInfo.shouldEscalate = true;
      escalationInfo.reasons.push(`Substance-based elevation: Workflow substance level is toy (no significant findings)`);
    }

    process.stdout.write(`    Substance level: ${substanceLevel}\n`);
    process.stdout.write(`    Should escalate: ${escalationInfo.shouldEscalate ? 'YES' : 'NO'}\n`);

    if (escalationInfo.reasons.length > 0) {
      escalationInfo.reasons.forEach(reason => {
        process.stdout.write(`      • ${reason}\n`);
      });
    }

    // Step 3: Generate report (using Report Writer agent)
    process.stdout.write(`[Step 3] Generating unified report...\n`);

    let report;
    try {
      report = await generateReport(workflowFindings);
    } catch (err) {
      process.stdout.write(`    ! Report Writer failed, using fallback format\n`);
      report = fallbackReportGeneration(workflowType, workflowResult);
    }

    // Step 4: Determine final status
    process.stdout.write(`[Step 4] Determining final status...\n`);

    let finalStatus = 'APPROVED';
    if (escalationInfo.shouldEscalate) {
      finalStatus = 'ESCALATED';
      process.stdout.write(`    ! Findings require human review\n`);
    } else {
      process.stdout.write(`    ✓ Auto-approved (no escalation criteria met)\n`);
    }

    // Construct final output (caller is responsible for persisting)
    const finalOutput = {
      run_id: runId,
      workflow_type: workflowType,
      workflow_executed: workflowType,
      environment: environment,
      workflow_findings: workflowResult,
      escalation_info: escalationInfo,
      substance_level: substanceLevel,
      final_status: finalStatus,
      report: report,
      timestamp: new Date().toISOString(),
    };

    process.stdout.write(`\n=== Orchestration Complete ===\n`);
    process.stdout.write(`Status: ${finalStatus}\n`);
    process.stdout.write(`Run ID: ${runId}\n`);

    // Persist results to disk
    try {
      const writeStatus = await writeResults(finalOutput, runId);
      process.stdout.write(`Results: ${writeStatus.resultsFile}\n`);
      process.stdout.write(`Report: ${writeStatus.reportFile}\n`);
    } catch (err) {
      process.stdout.write(`    ! Failed to write results: ${err.message}\n`);
    }

    if (escalationInfo.shouldEscalate) {
      process.stdout.write(`\nNext step: Review findings and make a decision\n`);
      process.stdout.write(`Command: node punch-out/human-decision-cli.js approve ${runId}\n`);
    }
    process.stdout.write('\n');

    return finalOutput;
  } catch (err) {
    process.stderr.write(`\nError: ${err.message}\n`);
    process.exit(1);
  }
}

// Generate basic report for fallback (Report Writer agent may fail)
function fallbackReportGeneration(workflowType, findings) {
  let report = '# Infrastructure & Security Review Report\n\n';

  if (workflowType === 'terraform') {
    report += '## Infrastructure (Terraform) Findings\n\n';
    report += `Risk Level: **${findings.risk_level}**\n\n`;

    if (findings.destructive_changes && findings.destructive_changes.length > 0) {
      report += '### Destructive Changes\n';
      findings.destructive_changes.forEach(change => {
        report += `- **${change.resource}** (${change.severity}): ${change.action}\n`;
      });
      report += '\n';
    }

    if (findings.security_exposure && findings.security_exposure.length > 0) {
      report += '### Security Exposure\n';
      findings.security_exposure.forEach(issue => {
        report += `- **${issue.resource}** (${issue.severity}): ${issue.issue}\n`;
      });
      report += '\n';
    }
  } else if (workflowType === 'kubernetes') {
    report += '## Container Security (Kubernetes) Findings\n\n';
    report += `Risk Level: **${findings.risk_level}**\n\n`;
    if (findings.summary) {
      report += `${findings.summary}\n\n`;
    }

    if (findings.security_issues && findings.security_issues.length > 0) {
      report += '### Security Issues\n';
      findings.security_issues.forEach(issue => {
        report += `- **${issue.resource_name}** (${issue.severity}): ${issue.description}\n`;
      });
      report += '\n';
    }
  } else if (workflowType === 'iam') {
    report += '## Access Control (IAM) Findings\n\n';
    report += `Risk Level: **${findings.risk_level}**\n\n`;
    if (findings.summary) {
      report += `${findings.summary}\n\n`;
    }

    if (findings.access_issues && findings.access_issues.length > 0) {
      report += '### Access Issues\n';
      findings.access_issues.forEach(issue => {
        report += `- **${issue.type}** (${issue.severity}): ${issue.description}\n`;
      });
      report += '\n';
    }
  }

  report += '\n## Recommendations\n\nReview findings above and prioritize by severity (CRITICAL → LOW).\n';

  return report;
}

if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { executeWorkflow };
