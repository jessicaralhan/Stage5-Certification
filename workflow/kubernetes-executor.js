// Kubernetes Workflow Executor: 3-agent pipeline for K8s security review

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

async function runKubernetesWorkflow(manifestContent, environment) {
  const audit = {
    workflow: 'kubernetes',
    steps: [],
    status: 'RUNNING',
  };

  try {
    // Step 1: Agent 1 - Manifest Analyzer
    process.stdout.write('  → Agent 1B: Analyzing Kubernetes manifests...\n');

    const agent1Prompt = loadPrompt('workflow2-kubernetes-analyzer.md');
    const agent1Input = agent1Prompt
      .replace('{{manifests}}', manifestContent)
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
      step: 'agent1_kubernetes_analyzer',
      status: 'COMPLETE',
      findings: agent1Findings,
    });

    process.stdout.write(`    ✓ Risk level: ${agent1Findings.risk_level}\n`);
    process.stdout.write(`    ✓ Issues found: ${(agent1Findings.security_issues || []).length}\n`);

    // If no issues, return early
    if (agent1Findings.risk_level === 'LOW' && (!agent1Findings.security_issues || agent1Findings.security_issues.length === 0)) {
      return {
        workflow: 'kubernetes',
        risk_level: 'LOW',
        security_issues: agent1Findings.security_issues || [],
        summary: agent1Findings.summary || 'No significant security issues found',
        fixes: [],
        verdict: 'APPROVE',
        audit_trail: audit,
      };
    }

    // Step 2: Agent 2 - Hardening Generator
    process.stdout.write('  → Agent 2B: Generating fixes...\n');

    const agent2Prompt = loadPrompt('workflow2-kubernetes-generator.md');
    const agent2Input = agent2Prompt
      .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
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
      step: 'agent2_kubernetes_generator',
      status: 'COMPLETE',
      fixes: agent2Fixes,
    });

    process.stdout.write(`    ✓ Fixes generated: ${(agent2Fixes.fixes || []).length}\n`);

    // Step 3: Agent 3 - Adversarial Reviewer
    process.stdout.write('  → Agent 3B: Reviewing fixes...\n');

    const agent3Prompt = loadPrompt('workflow2-kubernetes-reviewer.md');
    const agent3Input = agent3Prompt
      .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
      .replace('{{fixes}}', JSON.stringify(agent2Fixes, null, 2))
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
      step: 'agent3_kubernetes_reviewer',
      status: 'COMPLETE',
      verdict: agent3Review.verdict,
      review: agent3Review,
    });

    process.stdout.write(`    ✓ Verdict: ${agent3Review.verdict}\n`);

    audit.final_risk_level = agent1Findings.risk_level;
    audit.status = agent3Review.verdict === 'APPROVE' ? 'APPROVED' : agent3Review.verdict === 'REVISE' ? 'REVISE' : 'ESCALATE';

    return {
      workflow: 'kubernetes',
      risk_level: agent1Findings.risk_level,
      security_issues: agent1Findings.security_issues,
      summary: agent1Findings.summary,
      fixes: agent2Fixes.fixes,
      verdict: agent3Review.verdict,
      audit_trail: audit,
    };
  } catch (err) {
    return {
      workflow: 'kubernetes',
      risk_level: 'UNKNOWN',
      security_issues: [],
      summary: `Error during analysis: ${err.message}`,
      fixes: [],
      verdict: 'ERROR',
      audit_trail: { ...audit, status: 'FAILED', error: err.message },
    };
  }
}

async function run(inputFile, environment) {
  const content = fs.readFileSync(inputFile, 'utf-8');
  return runKubernetesWorkflow(content, environment);
}

module.exports = { run, runKubernetesWorkflow };
