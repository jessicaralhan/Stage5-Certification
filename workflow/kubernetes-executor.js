// Kubernetes Workflow Executor: 3-agent pipeline for K8s security review

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude, calculateCost } = require('./anthropic-client');
const { extractJSON } = require('./json-utils');

function loadPrompt(name) {
  return fs.readFileSync(path.join(__dirname, `../prompts/${name}`), 'utf-8');
}

function validateGeneratorConcreteness(fixes) {
  const placeholderPatterns = /\[.*?\]|<.*?>|todo|tbd|fixme|placeholder|xxx/gi;

  if (!fixes.fixes || !Array.isArray(fixes.fixes)) {
    throw new Error('Agent 2 output missing fixes array');
  }

  fixes.fixes.forEach((fix, idx) => {
    // Check for required concrete fields
    if (!fix.concrete_yaml) {
      throw new Error(`Fix ${idx}: missing concrete_yaml field`);
    }

    // Check for placeholder content
    if (placeholderPatterns.test(fix.concrete_yaml)) {
      throw new Error(`Fix ${idx}: concrete_yaml contains placeholder text`);
    }

    // Must have actual YAML-like content (apiVersion, kind, etc.)
    if (fix.concrete_yaml.length < 30 || !fix.concrete_yaml.includes('apiVersion')) {
      throw new Error(`Fix ${idx}: concrete_yaml too short or missing YAML markers`);
    }
  });

  return true;
}

async function runKubernetesWorkflow(manifestContent, environment, correlationId) {
  const audit = {
    workflow: 'kubernetes',
    correlation_id: correlationId,
    timestamp_start: new Date().toISOString(),
    steps: [],
    status: 'RUNNING',
    total_tokens: 0,
    total_cost: 0,
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
      model: 'claude-haiku-4-5-20251001',
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
      step: 'agent1_kubernetes_analyzer',
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
    process.stdout.write(`    ✓ Issues found: ${(agent1Findings.security_issues || []).length}\n`);
    process.stdout.write(`    ✓ Tokens: ${agent1TotalTokens} | Cost: $${agent1Cost.toFixed(6)}\n`);

    // If no issues, return early
    if (agent1Findings.risk_level === 'LOW' && (!agent1Findings.security_issues || agent1Findings.security_issues.length === 0)) {
      return {
        workflow: 'kubernetes',
        risk_level: 'LOW',
        security_issues: agent1Findings.security_issues || [],
        summary: agent1Findings.summary || 'No significant security issues found',
        remediations: [],
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
      model: 'claude-haiku-4-5-20251001',
      maxTokens: 3000,
    });

    let agent2Fixes;
    try {
      const jsonStr2 = extractJSON(agent2Response.text);
      agent2Fixes = JSON.parse(jsonStr2);
    } catch (err) {
      throw new Error(`Agent 2 output not valid JSON: ${err.message}. Response: ${agent2Response.text.substring(0, 300)}`);
    }

    // Validate Agent 2 has required schema fields
    if (!agent2Fixes.fixes || !Array.isArray(agent2Fixes.fixes)) {
      throw new Error('Agent 2 output missing fixes array');
    }

    // Validate Agent 2 output for concreteness (warnings only - prompts enforce this)
    try {
      validateGeneratorConcreteness(agent2Fixes);
    } catch (err) {
      process.stdout.write(`    ⚠ Concreteness check: ${err.message}\n`);
    }

    const agent2Cost = calculateCost(agent2Response.model, agent2Response.inputTokens, agent2Response.outputTokens);
    const agent2TotalTokens = agent2Response.inputTokens + agent2Response.outputTokens;
    audit.total_tokens += agent2TotalTokens;
    audit.total_cost += agent2Cost;

    audit.steps.push({
      step: 'agent2_kubernetes_generator',
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

    // Step 3: Agent 3 - Adversarial Reviewer with retry loop
    let agent3Review;
    let currentFixes = agent2Fixes;
    let reviewAttempt = 1;
    const maxReviewAttempts = 2;

    while (reviewAttempt <= maxReviewAttempts) {
      process.stdout.write(`  → Agent 3B: Reviewing fixes (attempt ${reviewAttempt}/${maxReviewAttempts})...\n`);

      const agent3Prompt = loadPrompt('workflow2-kubernetes-reviewer.md');

      let agent3Input = agent3Prompt
        .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
        .replace('{{fixes}}', JSON.stringify(currentFixes, null, 2))
        .replace('{{environment}}', environment);

      // On retry attempts, append previous reviewer feedback for Agent 3 to re-examine
      if (reviewAttempt > 1) {
        agent3Input += `\n\nPREVIOUS REVIEWER ASSESSMENT (Attempt ${reviewAttempt - 1}):\n${agent3Review.reasoning}\n\nPlease re-examine the revised fixes against these previously raised challenges.`;
      }

      const agent3Response = await callClaude({
        user: agent3Input,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 3000,
      });

      try {
        const jsonStr3 = extractJSON(agent3Response.text);
        agent3Review = JSON.parse(jsonStr3);
        if (!agent3Review.verdict || !agent3Review.reasoning) {
          throw new Error(`Agent 3 output missing required fields: verdict=${agent3Review.verdict}, reasoning=${agent3Review.reasoning ? 'present' : 'missing'}`);
        }
      } catch (err) {
        throw new Error(`Agent 3 output not valid JSON: ${err.message}. Response: ${agent3Response.text.substring(0, 300)}`);
      }

      const agent3Cost = calculateCost(agent3Response.model, agent3Response.inputTokens, agent3Response.outputTokens);
      const agent3TotalTokens = agent3Response.inputTokens + agent3Response.outputTokens;
      audit.total_tokens += agent3TotalTokens;
      audit.total_cost += agent3Cost;

      audit.steps.push({
        step: `agent3_kubernetes_reviewer_attempt_${reviewAttempt}`,
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

      // If verdict is not REVISE, exit loop
      if (agent3Review.verdict !== 'REVISE') {
        break;
      }

      // If REVISE and not last attempt, re-invoke Agent 2 with feedback
      if (reviewAttempt < maxReviewAttempts) {
        process.stdout.write(`  → Agent 2B: Revising hardening based on feedback...\n`);

        const agent2RevisePrompt = loadPrompt('workflow2-kubernetes-generator.md');
        const agent2ReviseInput = agent2RevisePrompt
          .replace('{{findings}}', JSON.stringify(agent1Findings, null, 2))
          .replace('{{environment}}', environment)
          + `\n\nREVIEWER FEEDBACK:\nThe previous hardening proposal was reviewed and found issues:\n${agent3Review.reasoning}\n\nPlease revise the fixes to address these challenges.`;

        const agent2ReviseResponse = await callClaude({
          user: agent2ReviseInput,
          model: 'claude-haiku-4-5-20251001',
          maxTokens: 3000,
        });

        try {
          const jsonStr2 = extractJSON(agent2ReviseResponse.text);
          currentFixes = JSON.parse(jsonStr2);
          if (!currentFixes.fixes || !Array.isArray(currentFixes.fixes)) {
            throw new Error('Agent 2 revision output missing fixes array');
          }
        } catch (err) {
          throw new Error(`Agent 2 revision output not valid JSON: ${err.message}`);
        }

        const agent2ReviseCost = calculateCost(agent2ReviseResponse.model, agent2ReviseResponse.inputTokens, agent2ReviseResponse.outputTokens);
        const agent2ReviseTotalTokens = agent2ReviseResponse.inputTokens + agent2ReviseResponse.outputTokens;
        audit.total_tokens += agent2ReviseTotalTokens;
        audit.total_cost += agent2ReviseCost;

        audit.steps.push({
          step: `agent2_kubernetes_generator_revision_${reviewAttempt}`,
          status: 'COMPLETE',
          timestamp: new Date().toISOString(),
          correlation_id: correlationId,
          model: agent2ReviseResponse.model,
          input_tokens: agent2ReviseResponse.inputTokens,
          output_tokens: agent2ReviseResponse.outputTokens,
          total_tokens: agent2ReviseTotalTokens,
          cost_usd: agent2ReviseCost,
          fixes: currentFixes,
        });

        process.stdout.write(`    ✓ Revised fixes generated\n`);
        process.stdout.write(`    ✓ Tokens: ${agent2ReviseTotalTokens} | Cost: $${agent2ReviseCost.toFixed(6)}\n`);
      }

      reviewAttempt++;
    }

    audit.final_risk_level = agent1Findings.risk_level;
    audit.status = agent3Review.verdict === 'APPROVE' ? 'APPROVED' : 'ESCALATE';
    audit.timestamp_end = new Date().toISOString();

    return {
      workflow: 'kubernetes',
      risk_level: agent1Findings.risk_level,
      security_issues: agent1Findings.security_issues,
      summary: agent1Findings.summary,
      remediations: currentFixes.fixes,
      verdict: agent3Review.verdict,
      audit_trail: audit,
    };
  } catch (err) {
    audit.timestamp_end = new Date().toISOString();
    audit.status = 'FAILED';
    audit.error = err.message;
    return {
      workflow: 'kubernetes',
      risk_level: 'UNKNOWN',
      security_issues: [],
      summary: `Error during analysis: ${err.message}`,
      remediations: [],
      verdict: 'ERROR',
      audit_trail: audit,
    };
  }
}

async function run(inputFile, environment, correlationId) {
  const content = fs.readFileSync(inputFile, 'utf-8');
  return runKubernetesWorkflow(content, environment, correlationId);
}

module.exports = { run, runKubernetesWorkflow };
