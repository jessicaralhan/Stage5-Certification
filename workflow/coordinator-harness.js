#!/usr/bin/env node

// Coordinator Harness: Multi-workflow orchestration engine
// Routes input to correct workflow, applies guardrails, returns unified report

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude } = require('./anthropic-client');
const { generateReport } = require('./report-writer-executor');
const { determineEscalation, assessSubstance } = require('./escalation-gates');

// Workflow dispatcher tools
const WORKFLOWS = {
  terraform: './workflow/terraform-executor.js',
  kubernetes: './workflow/kubernetes-executor.js',
  iam: './workflow/iam-executor.js',
};

// No file type detection here — coordinator agent handles this independently

// Call Coordinator Agent to make independent routing decision
async function callCoordinator(filePath, content, environment) {
  const coordinatorPrompt = fs.readFileSync(
    path.join(__dirname, '../prompts/coordinator-agent.md'),
    'utf-8'
  );

  // Coordinator gets first 1500 chars of input — enough for analysis, not the entire file
  const contentPreview = content.substring(0, 1500);

  const prompt = coordinatorPrompt
    .replace('{{input_file}}', path.basename(filePath))
    .replace('{{environment}}', environment)
    .replace('{{input_content}}', contentPreview);

  const result = await callClaude({
    user: prompt,
    model: 'claude-haiku-5-5',
    maxTokens: 500,
  });

  // Parse Coordinator's response
  let parsed;
  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`Coordinator response was not valid JSON: ${result.text.substring(0, 200)}`);
  }

  return parsed;
}

// Execute chosen workflow
async function executeWorkflow(workflowType, inputFile, environment, correlationId) {
  process.stdout.write(`\n[Orchestrator] Executing ${workflowType} workflow...\n`);

  // Import the appropriate workflow executor
  try {
    const executor = require(path.join(__dirname, `${workflowType}-executor.js`));
    const result = await executor.run(inputFile, environment, correlationId);
    return result;
  } catch (err) {
    throw new Error(`Failed to execute ${workflowType} workflow: ${err.message}`);
  }
}

// Main orchestration flow
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    process.stdout.write(`
Usage: node coordinator-harness.js <input_file> [environment]

Examples:
  node coordinator-harness.js config.tf production
  node coordinator-harness.js manifest.yaml staging
  node coordinator-harness.js policy.json production
`);
    process.exit(1);
  }

  const inputFile = args[0];
  const environment = args[1] || 'non-production';

  if (!fs.existsSync(inputFile)) {
    process.stderr.write(`Error: File not found: ${inputFile}\n`);
    process.exit(1);
  }

  process.stdout.write(`\n=== Stage 5 Coordinator: Multi-Workflow Orchestration ===\n`);
  process.stdout.write(`Input: ${inputFile}\n`);
  process.stdout.write(`Environment: ${environment}\n\n`);

  try {
    // Step 1: Load input
    const content = fs.readFileSync(inputFile, 'utf-8');
    process.stdout.write(`[Step 1] Loaded input file (${content.length} bytes)\n`);

    // Step 2: Call Coordinator for independent routing decision (no pre-detection hints)
    process.stdout.write(`[Step 2] Calling Coordinator for routing decision...\n`);
    const coordinatorDecision = await callCoordinator(inputFile, content, environment);

    if (!coordinatorDecision.decision) {
      throw new Error('Coordinator did not make a routing decision');
    }

    // Validate coordinator decision is one of the valid workflows
    if (!['terraform', 'kubernetes', 'iam'].includes(coordinatorDecision.decision)) {
      throw new Error(`Coordinator returned invalid workflow: ${coordinatorDecision.decision}`);
    }

    process.stdout.write(`[Step 2] Coordinator decision: ${coordinatorDecision.decision} (${coordinatorDecision.confidence})\n`);
    process.stdout.write(`         Reason: ${coordinatorDecision.reason}\n`);

    // Step 3: Execute the chosen workflow
    process.stdout.write(`[Step 3] Executing workflow...\n`);
    const runId = `${Date.now()}`;
    const workflowResult = await executeWorkflow(coordinatorDecision.decision, inputFile, environment, runId);

    process.stdout.write(`[Step 3] Workflow complete. Risk level: ${workflowResult.risk_level}\n`);

    // Step 4: Check escalation gates
    process.stdout.write(`[Step 4] Checking escalation gates...\n`);

    const workflowFindings = {};
    workflowFindings[coordinatorDecision.decision] = workflowResult;

    const substanceLevel = assessSubstance(workflowFindings, environment);
    const escalationInfo = determineEscalation(workflowFindings, environment);

    // Check substance-based elevation: if toy, escalate
    // Note: In this architecture, each run executes exactly one workflow, so the 2+ peripheral check
    // would require multiple independent runs to be evaluated together (outside this coordinator)
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

    // Step 5: Generate report (using Report Writer agent)
    process.stdout.write(`[Step 5] Generating unified report...\n`);

    let report;
    try {
      report = await generateReport(workflowFindings);
    } catch (err) {
      process.stdout.write(`    ! Report Writer failed, using fallback format\n`);
      report = fallbackReportGeneration(coordinatorDecision.decision, workflowResult);
    }

    // Step 6: Determine final status
    process.stdout.write(`[Step 6] Determining final status...\n`);

    let finalStatus = 'APPROVED';
    if (escalationInfo.shouldEscalate) {
      finalStatus = 'ESCALATED';
      process.stdout.write(`    ! Findings require human review\n`);
    } else {
      process.stdout.write(`    ✓ Auto-approved (no escalation criteria met)\n`);
    }

    // Step 7: Output results
    process.stdout.write(`[Step 7] Writing results...\n`);

    const resultsDir = path.join(__dirname, '../results');
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }

    const finalOutput = {
      run_id: runId,
      coordinator_decision: coordinatorDecision.decision,
      workflow_executed: coordinatorDecision.decision,
      environment: environment,
      workflow_findings: workflowResult,
      escalation_info: escalationInfo,
      substance_level: substanceLevel,
      final_status: finalStatus,
      report: report,
      timestamp: new Date().toISOString(),
    };

    const resultsFile = path.join(resultsDir, `run-${runId}-output.json`);
    fs.writeFileSync(resultsFile, JSON.stringify(finalOutput, null, 2));

    // Also write report as separate markdown file
    const reportFile = path.join(resultsDir, `run-${runId}-report.md`);
    fs.writeFileSync(reportFile, report);

    process.stdout.write(`\n=== Orchestration Complete ===\n`);
    process.stdout.write(`Status: ${finalStatus}\n`);
    process.stdout.write(`Run ID: ${runId}\n`);
    process.stdout.write(`Results: ${resultsFile}\n`);
    process.stdout.write(`Report: ${reportFile}\n`);

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
    report += `${findings.summary}\n\n`;

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
    report += `${findings.summary}\n\n`;

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

module.exports = { callCoordinator, executeWorkflow };
