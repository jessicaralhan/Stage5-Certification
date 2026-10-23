// Terraform Workflow Executor: 3-agent pipeline for terraform safety review

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude } = require('./anthropic-client');

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

async function runTerraformWorkflow(planContent, environment) {
  const audit = {
    workflow: 'terraform',
    steps: [],
    status: 'RUNNING',
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

    audit.steps.push({
      step: 'agent1_terraform_analyzer',
      status: 'COMPLETE',
      findings: agent1Findings,
    });

    process.stdout.write(`    ✓ Risk level: ${agent1Findings.risk_level}\n`);
    process.stdout.write(`    ✓ Issues found: ${(agent1Findings.destructive_changes || []).length} destructive, ${(agent1Findings.security_exposure || []).length} security\n`);

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

    audit.steps.push({
      step: 'agent2_remediation_generator',
      status: 'COMPLETE',
      remediations: agent2Remediations,
    });

    process.stdout.write(`    ✓ Fixes generated: ${(agent2Remediations.remediations || []).length}\n`);

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

    audit.steps.push({
      step: 'agent3_adversarial_reviewer',
      status: 'COMPLETE',
      verdict: agent3Review.verdict,
      review: agent3Review,
    });

    process.stdout.write(`    ✓ Verdict: ${agent3Review.verdict}\n`);

    // Determine final status
    audit.final_risk_level = agent1Findings.risk_level;
    audit.status = agent3Review.verdict === 'APPROVE' ? 'APPROVED' : agent3Review.verdict === 'REVISE' ? 'REVISE' : 'ESCALATE';

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
    return {
      workflow: 'terraform',
      risk_level: 'UNKNOWN',
      destructive_changes: [],
      security_exposure: [],
      cost_notes: [],
      remediations: [],
      verdict: 'ERROR',
      audit_trail: { ...audit, status: 'FAILED', error: err.message },
    };
  }
}

async function run(inputFile, environment) {
  const content = fs.readFileSync(inputFile, 'utf-8');
  return runTerraformWorkflow(content, environment);
}

module.exports = { run, runTerraformWorkflow };
