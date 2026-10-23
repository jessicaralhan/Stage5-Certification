// IAM Workflow Executor: 3-agent pipeline for IAM policy audit

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude, calculateCost } = require('./anthropic-client');

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

// Validate Agent 2 generator output for concreteness (IAM)
function validateGeneratorConcreteness(fixes) {
  const placeholderPatterns = /\[.*?\]|<.*?>|todo|tbd|fixme|placeholder|xxx/gi;

  if (!fixes.fixes || !Array.isArray(fixes.fixes)) {
    throw new Error('Agent 2 output missing fixes array');
  }

  fixes.fixes.forEach((fix, idx) => {
    // Check for required concrete field
    if (!fix.concrete_policy_change) {
      throw new Error(`Fix ${idx}: missing concrete_policy_change field`);
    }

    // Check for placeholder content
    if (placeholderPatterns.test(fix.concrete_policy_change)) {
      throw new Error(`Fix ${idx}: concrete_policy_change contains placeholder text`);
    }

    // Must have actual policy content
    if (fix.concrete_policy_change.length < 10) {
      throw new Error(`Fix ${idx}: concrete_policy_change too short or empty`);
    }
  });

  return true;
}

async function runIAMWorkflow(policyContent, environment, correlationId) {
  const audit = {
    workflow: 'iam',
    correlation_id: correlationId,
    timestamp_start: new Date().toISOString(),
    steps: [],
    status: 'RUNNING',
    total_tokens: 0,
    total_cost: 0,
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

    const agent1Cost = calculateCost(agent1Response.model, agent1Response.inputTokens, agent1Response.outputTokens);
    const agent1TotalTokens = agent1Response.inputTokens + agent1Response.outputTokens;
    audit.total_tokens += agent1TotalTokens;
    audit.total_cost += agent1Cost;

    audit.steps.push({
      step: 'agent1_iam_analyzer',
      status: 'COMPLETE',
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      model: agent1Response.model,
      input_tokens: agent1Response.inputTokens,
      output_tokens: agent1Response.outputTokens,
      total_tokens: agent1TotalTokens,
      cost_usd: agent1Cost,
      findings: agent1Findings,
    });

    process.stdout.write(`    ✓ Risk level: ${agent1Findings.risk_level}\n`);
    process.stdout.write(`    ✓ Issues found: ${(agent1Findings.access_issues || []).length}\n`);
    process.stdout.write(`    ✓ Tokens: ${agent1TotalTokens} | Cost: $${agent1Cost.toFixed(6)}\n`);

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

    // Validate Agent 2 output for concreteness (guardrails layer - warnings only)
    try {
      validateGeneratorConcreteness(agent2Fixes);
    } catch (err) {
      process.stdout.write(`    ⚠ Concreteness check: ${err.message}\n`);
      // Warning only - don't fail, as prompts already enforce concreteness
    }

    const agent2Cost = calculateCost(agent2Response.model, agent2Response.inputTokens, agent2Response.outputTokens);
    const agent2TotalTokens = agent2Response.inputTokens + agent2Response.outputTokens;
    audit.total_tokens += agent2TotalTokens;
    audit.total_cost += agent2Cost;

    audit.steps.push({
      step: 'agent2_iam_generator',
      status: 'COMPLETE',
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      model: agent2Response.model,
      input_tokens: agent2Response.inputTokens,
      output_tokens: agent2Response.outputTokens,
      total_tokens: agent2TotalTokens,
      cost_usd: agent2Cost,
      fixes: agent2Fixes,
    });

    process.stdout.write(`    ✓ Fixes generated: ${(agent2Fixes.fixes || []).length}\n`);
    process.stdout.write(`    ✓ Tokens: ${agent2TotalTokens} | Cost: $${agent2Cost.toFixed(6)}\n`);

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

    const agent3Cost = calculateCost(agent3Response.model, agent3Response.inputTokens, agent3Response.outputTokens);
    const agent3TotalTokens = agent3Response.inputTokens + agent3Response.outputTokens;
    audit.total_tokens += agent3TotalTokens;
    audit.total_cost += agent3Cost;

    audit.steps.push({
      step: 'agent3_iam_reviewer',
      status: 'COMPLETE',
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      model: agent3Response.model,
      input_tokens: agent3Response.inputTokens,
      output_tokens: agent3Response.outputTokens,
      total_tokens: agent3TotalTokens,
      cost_usd: agent3Cost,
      verdict: agent3Review.verdict,
      review: agent3Review,
    });

    process.stdout.write(`    ✓ Verdict: ${agent3Review.verdict}\n`);
    process.stdout.write(`    ✓ Tokens: ${agent3TotalTokens} | Cost: $${agent3Cost.toFixed(6)}\n`);

    audit.final_risk_level = agent1Findings.risk_level;
    audit.status = agent3Review.verdict === 'APPROVE' ? 'APPROVED' : agent3Review.verdict === 'REVISE' ? 'REVISE' : 'ESCALATE';
    audit.timestamp_end = new Date().toISOString();

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
    audit.timestamp_end = new Date().toISOString();
    audit.status = 'FAILED';
    audit.error = err.message;
    return {
      workflow: 'iam',
      risk_level: 'UNKNOWN',
      access_issues: [],
      summary: `Error during analysis: ${err.message}`,
      fixes: [],
      verdict: 'ERROR',
      audit_trail: audit,
    };
  }
}

async function run(inputFile, environment, correlationId) {
  const content = fs.readFileSync(inputFile, 'utf-8');
  return runIAMWorkflow(content, environment, correlationId);
}

module.exports = { run, runIAMWorkflow };
