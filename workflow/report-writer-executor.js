// Report Writer Executor: Synthesizes findings into unified reports

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude } = require('./anthropic-client');

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, `../prompts/${name}`), 'utf-8');
}

// Determine combined risk level from all workflows
function getCombinedRiskLevel(workflowFindings) {
  const severityOrder = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

  let maxSeverity = 0;
  Object.values(workflowFindings).forEach(findings => {
    if (findings && findings.risk_level) {
      maxSeverity = Math.max(maxSeverity, severityOrder[findings.risk_level] || 0);
    }
  });

  const severityMap = { 4: 'CRITICAL', 3: 'HIGH', 2: 'MEDIUM', 1: 'LOW', 0: 'LOW' };
  return severityMap[maxSeverity];
}

// Determine which workflows were triggered based on findings
function getTriggeredWorkflows(workflowFindings) {
  const triggered = [];

  if (workflowFindings.terraform && workflowFindings.terraform.workflow === 'terraform') {
    triggered.push('Terraform Safety Review (Infrastructure)');
  }
  if (workflowFindings.kubernetes && workflowFindings.kubernetes.workflow === 'kubernetes') {
    triggered.push('Kubernetes Security Review (Container Security)');
  }
  if (workflowFindings.iam && workflowFindings.iam.workflow === 'iam') {
    triggered.push('IAM Policy Audit (Access Control)');
  }

  return triggered;
}

async function generateReport(workflowFindings) {
  try {
    // Determine triggered workflows and combined risk
    const triggeredWorkflows = getTriggeredWorkflows(workflowFindings);
    const combinedRiskLevel = getCombinedRiskLevel(workflowFindings);

    if (triggeredWorkflows.length === 0) {
      return '# Infrastructure & Security Review Report\n\nNo findings to report.\n';
    }

    // Load Report Writer prompt
    const reportWriterPrompt = loadPrompt('report-writer.md');

    // Prepare input for Report Writer
    const prompt = reportWriterPrompt
      .replace('{{triggered_workflows}}', triggeredWorkflows.join(', '))
      .replace('{{combined_risk_level}}', combinedRiskLevel)
      .replace('{{findings_json}}', JSON.stringify(workflowFindings, null, 2));

    // Call Report Writer agent
    process.stdout.write('  → Report Writer: Synthesizing findings into report...\n');

    const result = await callClaude({
      user: prompt,
      model: 'claude-haiku-5-5',
      maxTokens: 4000,
    });

    process.stdout.write('    ✓ Report generated\n');

    // Report Writer returns markdown directly
    return result.text;
  } catch (err) {
    process.stderr.write(`Error generating report: ${err.message}\n`);
    return `# Error Generating Report\n\nFailed to synthesize findings: ${err.message}\n`;
  }
}

module.exports = { generateReport, getCombinedRiskLevel, getTriggeredWorkflows };
