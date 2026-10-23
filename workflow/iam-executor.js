// IAM Workflow Executor: 3-agent pipeline for IAM policy audit

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude } = require('./anthropic-client');

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, `../prompts/${name}`), 'utf-8');
}

// Robust JSON extraction from LLM responses
function extractJSON(text) {
  // Remove markdown code fences if present
  let cleaned = text.replace(/```(json)?\s*/g, '').replace(/```\s*/g, '');

  // Find first { and matching }
  const startIdx = cleaned.indexOf('{');
  if (startIdx === -1) {
    throw new Error('No JSON object found');
  }

  let braceCount = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < cleaned.length; i++) {
    if (cleaned[i] === '{') braceCount++;
    if (cleaned[i] === '}') {
      braceCount--;
      if (braceCount === 0) {
        endIdx = i;
        break;
      }
    }
  }

  return cleaned.substring(startIdx, endIdx + 1);
}

async function runIAMWorkflow(policyContent, environment) {
  const audit = {
    workflow: 'iam',
    steps: [],
    status: 'RUNNING',
  };

  try {
    // Step 1: Agent 1 - Policy Analyzer
    process.stdout.write('  → Agent 1C: Analyzing IAM policy...\n');

    const agent1Prompt = loadPrompt('workflow3-iam-analyzer.md');
    const agent1Input = agent1Prompt
      .replace('{{policy}}', policyContent)
      .replace('{{cloud_platform}}', 'aws')
      .replace('{{environment}}', environment);

    const agent1Response = await callClaude({
      user: agent1Input,
      model: 'claude-haiku-5-5',
      maxTokens: 4000,
    });

    // Parse Agent 1 output
    let agent1Findings;
    try {
      const jsonStr1 = extractJSON(agent1Response.text);
      agent1Findings = JSON.parse(jsonStr1);
    } catch (err) {
      throw new Error(`Agent 1 output not valid JSON: ${err.message}. Response: ${agent1Response.text.substring(0, 300)}`);
    }

    audit.steps.push({
      step: 'agent1_iam_analyzer',
      status: 'COMPLETE',
      findings: agent1Findings,
    });

    process.stdout.write(`    ✓ Risk level: ${agent1Findings.risk_level}\n`);
    process.stdout.write(`    ✓ Issues found: ${(agent1Findings.access_issues || []).length}\n`);

    // If no issues, return early
    if (agent1Findings.risk_level === 'LOW' && (!agent1Findings.access_issues || agent1Findings.access_issues.length === 0)) {
      return {
        workflow: 'iam',
        risk_level: 'LOW',
        access_issues: agent1Findings.access_issues || [],
        summary: agent1Findings.summary || 'No significant access control issues found',
        fixes: [],
        verdict: 'APPROVE',
        audit_trail: audit,
      };
    }

    // Step 2: Agent 2 - Access Tightener
    process.stdout.write('  → Agent 2C: Generating fixes...\n');

    const agent2Prompt = loadPrompt('workflow3-iam-generator.md');
    const agent2Input = agent2Prompt
      .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
      .replace('{{cloud_platform}}', 'aws')
      .replace('{{environment}}', environment);

    const agent2Response = await callClaude({
      user: agent2Input,
      model: 'claude-haiku-5-5',
      maxTokens: 3000,
    });

    let agent2Fixes;
    try {
      const jsonStr2 = extractJSON(agent2Response.text);
      agent2Fixes = JSON.parse(jsonStr2);
    } catch (err) {
      throw new Error(`Agent 2 output not valid JSON: ${err.message}. Response: ${agent2Response.text.substring(0, 300)}`);
    }

    audit.steps.push({
      step: 'agent2_iam_generator',
      status: 'COMPLETE',
      fixes: agent2Fixes,
    });

    process.stdout.write(`    ✓ Fixes generated: ${(agent2Fixes.fixes || []).length}\n`);

    // Step 3: Agent 3 - Adversarial Auditor
    process.stdout.write('  → Agent 3C: Reviewing fixes...\n');

    const agent3Prompt = loadPrompt('workflow3-iam-reviewer.md');
    const agent3Input = agent3Prompt
      .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
      .replace('{{fixes}}', JSON.stringify(agent2Fixes, null, 2))
      .replace('{{cloud_platform}}', 'aws')
      .replace('{{environment}}', environment);

    const agent3Response = await callClaude({
      user: agent3Input,
      model: 'claude-haiku-5-5',
      maxTokens: 3000,
    });

    let agent3Review;
    try {
      const jsonStr3 = extractJSON(agent3Response.text);
      agent3Review = JSON.parse(jsonStr3);
    } catch (err) {
      throw new Error(`Agent 3 output not valid JSON: ${err.message}. Response: ${agent3Response.text.substring(0, 300)}`);
    }

    audit.steps.push({
      step: 'agent3_iam_reviewer',
      status: 'COMPLETE',
      verdict: agent3Review.verdict,
      review: agent3Review,
    });

    process.stdout.write(`    ✓ Verdict: ${agent3Review.verdict}\n`);

    audit.final_risk_level = agent1Findings.risk_level;
    audit.status = agent3Review.verdict === 'APPROVE' ? 'APPROVED' : agent3Review.verdict === 'REVISE' ? 'REVISE' : 'ESCALATE';

    return {
      workflow: 'iam',
      risk_level: agent1Findings.risk_level,
      access_issues: agent1Findings.access_issues,
      summary: agent1Findings.summary,
      fixes: agent2Fixes.fixes,
      verdict: agent3Review.verdict,
      audit_trail: audit,
    };
  } catch (err) {
    return {
      workflow: 'iam',
      risk_level: 'UNKNOWN',
      access_issues: [],
      summary: `Error during analysis: ${err.message}`,
      fixes: [],
      verdict: 'ERROR',
      audit_trail: { ...audit, status: 'FAILED', error: err.message },
    };
  }
}

async function run(inputFile, environment) {
  const content = fs.readFileSync(inputFile, 'utf-8');
  return runIAMWorkflow(content, environment);
}

module.exports = { run, runIAMWorkflow };
