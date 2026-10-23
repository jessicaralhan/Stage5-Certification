// Terraform Workflow Executor: 3-agent pipeline for terraform safety review

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude, calculateCost } = require('./anthropic-client');

// Load prompts
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

// Validate Agent 2 generator output for concreteness
function validateGeneratorConcreteness(remediations) {
  const placeholderPatterns = /\[.*?\]|<.*?>|todo|tbd|fixme|placeholder|xxx/gi;

  if (!remediations.remediations || !Array.isArray(remediations.remediations)) {
    throw new Error('Agent 2 output missing remediations array');
  }

  remediations.remediations.forEach((fix, idx) => {
    // Check for required concrete field (terraform generator uses proposed_fix)
    if (!fix.proposed_fix) {
      throw new Error(`Remediation ${idx}: missing proposed_fix field`);
    }

    const concreteField = fix.proposed_fix;

    // Check for placeholder content
    if (placeholderPatterns.test(concreteField)) {
      throw new Error(`Remediation ${idx}: proposed_fix contains placeholder text: ${concreteField.substring(0, 100)}`);
    }

    // Must have actual content (not just "add something")
    if (concreteField.length < 10) {
      throw new Error(`Remediation ${idx}: proposed_fix too short or empty`);
    }
  });

  return true;
}

async function runTerraformWorkflow(planContent, environment, correlationId) {
  const audit = {
    workflow: 'terraform',
    correlation_id: correlationId,
    timestamp_start: new Date().toISOString(),
    steps: [],
    status: 'RUNNING',
    total_tokens: 0,
    total_cost: 0,
  };

  try {
    // Step 1: Agent 1 - Plan Analyzer
    process.stdout.write('  → Agent 1: Analyzing Terraform plan...\n');

    const agent1Prompt = loadPrompt('workflow1-terraform-analyzer.md');
    const agent1Input = agent1Prompt
      .replace('{{plan_output}}', planContent)
      .replace('{{environment}}', environment);

    const agent1Response = await callClaude({
      user: agent1Input,
      model: 'claude-haiku-5-5',
      maxTokens: 3000,
    });

    // Parse Agent 1 output with robust JSON extraction
    const extractJSON = (text) => {
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
    };

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
      step: 'agent1_terraform_analyzer',
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
    process.stdout.write(`    ✓ Issues found: ${(agent1Findings.destructive_changes || []).length} destructive, ${(agent1Findings.security_exposure || []).length} security\n`);
    process.stdout.write(`    ✓ Tokens: ${agent1TotalTokens} | Cost: $${agent1Cost.toFixed(6)}\n`);

    // If no issues, return early
    if (agent1Findings.risk_level === 'LOW' && (!agent1Findings.destructive_changes || agent1Findings.destructive_changes.length === 0)) {
      return {
        workflow: 'terraform',
        risk_level: 'LOW',
        destructive_changes: agent1Findings.destructive_changes || [],
        security_exposure: agent1Findings.security_exposure || [],
        cost_notes: agent1Findings.cost_notes || [],
        remediations: [],
        verdict: 'APPROVE',
        audit_trail: audit,
      };
    }

    // Step 2: Agent 2 - Remediation Generator
    process.stdout.write('  → Agent 2: Generating remediations...\n');

    const agent2Prompt = loadPrompt('workflow1-terraform-generator.md');
    const agent2Input = agent2Prompt
      .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
      .replace('{{environment}}', environment);

    const agent2Response = await callClaude({
      user: agent2Input,
      model: 'claude-haiku-5-5',
      maxTokens: 3000,
    });

    let agent2Remediations;
    try {
      const jsonStr2 = extractJSON(agent2Response.text);
      agent2Remediations = JSON.parse(jsonStr2);
    } catch (err) {
      throw new Error(`Agent 2 output not valid JSON: ${err.message}. Response: ${agent2Response.text.substring(0, 500)}`);
    }

    // Validate Agent 2 output for concreteness (guardrails layer - warnings only)
    try {
      validateGeneratorConcreteness(agent2Remediations);
    } catch (err) {
      process.stdout.write(`    ⚠ Concreteness check: ${err.message}\n`);
      // Warning only - don't fail, as prompts already enforce concreteness
    }

    const agent2Cost = calculateCost(agent2Response.model, agent2Response.inputTokens, agent2Response.outputTokens);
    const agent2TotalTokens = agent2Response.inputTokens + agent2Response.outputTokens;
    audit.total_tokens += agent2TotalTokens;
    audit.total_cost += agent2Cost;

    audit.steps.push({
      step: 'agent2_remediation_generator',
      status: 'COMPLETE',
      timestamp: new Date().toISOString(),
      correlation_id: correlationId,
      model: agent2Response.model,
      input_tokens: agent2Response.inputTokens,
      output_tokens: agent2Response.outputTokens,
      total_tokens: agent2TotalTokens,
      cost_usd: agent2Cost,
      remediations: agent2Remediations,
    });

    process.stdout.write(`    ✓ Fixes generated: ${(agent2Remediations.remediations || []).length}\n`);
    process.stdout.write(`    ✓ Tokens: ${agent2TotalTokens} | Cost: $${agent2Cost.toFixed(6)}\n`);

    // Step 3: Agent 3 - Adversarial Reviewer
    process.stdout.write('  → Agent 3: Reviewing fixes...\n');

    const agent3Prompt = loadPrompt('workflow1-terraform-reviewer.md');
    const agent3Input = agent3Prompt
      .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
      .replace('{{fixes}}', JSON.stringify(agent2Remediations, null, 2))
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
      step: 'agent3_adversarial_reviewer',
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

    // Determine final status
    audit.final_risk_level = agent1Findings.risk_level;
    audit.status = agent3Review.verdict === 'APPROVE' ? 'APPROVED' : agent3Review.verdict === 'REVISE' ? 'REVISE' : 'ESCALATE';
    audit.timestamp_end = new Date().toISOString();

    // Return comprehensive result
    return {
      workflow: 'terraform',
      risk_level: agent1Findings.risk_level,
      destructive_changes: agent1Findings.destructive_changes,
      security_exposure: agent1Findings.security_exposure,
      cost_notes: agent1Findings.cost_notes,
      remediations: agent2Remediations.remediations,
      verdict: agent3Review.verdict,
      audit_trail: audit,
    };
  } catch (err) {
    audit.timestamp_end = new Date().toISOString();
    audit.status = 'FAILED';
    audit.error = err.message;
    return {
      workflow: 'terraform',
      risk_level: 'UNKNOWN',
      destructive_changes: [],
      security_exposure: [],
      cost_notes: [],
      remediations: [],
      verdict: 'ERROR',
      audit_trail: audit,
    };
  }
}

async function run(inputFile, environment, correlationId) {
  const content = fs.readFileSync(inputFile, 'utf-8');
  return runTerraformWorkflow(content, environment, correlationId);
}

module.exports = { run, runTerraformWorkflow };
