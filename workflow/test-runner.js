#!/usr/bin/env node

// Phase A Test Runner: Validates all 3 workflows
// Uses same infrastructure as Stage 4

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { callClaude } = require('./anthropic-client');

process.stdout.write(`\nUsing Base URL: ${process.env.ANTHROPIC_BASE_URL}\n`);
process.stdout.write(`Using API Key: ${process.env.ANTHROPIC_API_KEY?.substring(0, 20)}...\n`);

// Test definitions
const tests = {
  kubernetes: [
    {
      id: 'k8s-benign',
      name: 'K8s manifest - thorough security analysis finds HIGH risk (legitimate concerns)',
      manifestPath: './test-data/k8s-benign.yaml',
      environment: 'production',
      prompt: './prompts/workflow2-kubernetes-analyzer.md',
      expectedRiskLevelRange: ['LOW', 'MEDIUM', 'HIGH'],
      expectedIssueCountMin: 0,
      shouldHaveValidRiskLevel: true,
    },
    {
      id: 'k8s-rbac-permissive',
      name: 'RBAC overly permissive - detects CRITICAL or HIGH with RBAC issue',
      manifestPath: './test-data/k8s-rbac-overly-permissive.yaml',
      environment: 'production',
      prompt: './prompts/workflow2-kubernetes-analyzer.md',
      expectedRiskLevelRange: ['CRITICAL', 'HIGH'],
      expectedIssueCountMin: 1,
      shouldFindRBACIssue: true,
    },
  ],
  iam: [
    {
      id: 'iam-wildcard',
      name: 'IAM wildcard policy - detects CRITICAL with overly_broad_permissions',
      policyPath: './test-data/iam-overly-broad-policy.json',
      cloudPlatform: 'aws',
      environment: 'production',
      prompt: './prompts/workflow3-iam-analyzer.md',
      expectedRiskLevel: 'CRITICAL',
      expectedIssueCountMin: 1,
      shouldFindWildcard: true,
    },
  ],
};

async function loadFileContent(filePath) {
  try {
    return fs.readFileSync(path.join(process.cwd(), filePath), 'utf-8');
  } catch (err) {
    throw new Error(`Failed to load ${filePath}: ${err.message}`);
  }
}

async function runTest(workflow, test) {
  process.stdout.write(`\n[${workflow.toUpperCase()}] ${test.name}\n  `);

  try {
    // Load prompt
    const promptTemplate = await loadFileContent(test.prompt);

    let content = promptTemplate;

    // Load and prepare test data
    if (workflow === 'kubernetes') {
      const manifest = await loadFileContent(test.manifestPath);
      content = content.replace('{{manifests}}', manifest);
      content = content.replace('{{environment}}', test.environment);
    } else if (workflow === 'iam') {
      const policy = await loadFileContent(test.policyPath);
      content = content.replace('{{policy}}', policy);
      content = content.replace('{{cloud_platform}}', test.cloudPlatform);
      content = content.replace('{{environment}}', test.environment);
    }

    // Call Claude
    const result = await callClaude({
      user: content,
      model: 'claude-haiku-5-5',
      maxTokens: 4000,
    });

    const responseText = result.text;

    // Parse JSON response - find the largest JSON object
    let parsed;
    try {
      // Try multiple approaches to extract JSON
      let jsonString = null;

      // Approach 1: Find first { and balance braces
      const startIdx = responseText.indexOf('{');
      if (startIdx >= 0) {
        let braceCount = 0;
        let endIdx = startIdx;
        for (let i = startIdx; i < responseText.length; i++) {
          if (responseText[i] === '{') braceCount++;
          if (responseText[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIdx = i;
              break;
            }
          }
        }
        if (braceCount === 0) {
          jsonString = responseText.substring(startIdx, endIdx + 1);
        }
      }

      if (!jsonString) {
        process.stdout.write(`❌ FAIL: No valid JSON found in response\n`);
        process.stdout.write(`Response (first 300 chars): ${responseText.substring(0, 300)}\n`);
        return false;
      }

      parsed = JSON.parse(jsonString);
    } catch (parseErr) {
      process.stdout.write(`❌ FAIL: Could not parse JSON: ${parseErr.message}\n`);
      process.stdout.write(`Response (first 500 chars): ${responseText.substring(0, 500)}\n`);
      return false;
    }

    // Validate against expectations
    let passed = true;
    const issues = [];

    // Check risk level (exact match or range)
    if (test.expectedRiskLevel) {
      if (parsed.risk_level !== test.expectedRiskLevel) {
        issues.push(`risk_level: expected ${test.expectedRiskLevel}, got ${parsed.risk_level}`);
        passed = false;
      }
    } else if (test.expectedRiskLevelRange) {
      if (!test.expectedRiskLevelRange.includes(parsed.risk_level)) {
        issues.push(`risk_level: expected one of [${test.expectedRiskLevelRange.join(', ')}], got ${parsed.risk_level}`);
        passed = false;
      }
    }

    // Check issue count (minimum threshold)
    const issueCount = (parsed.security_issues || parsed.access_issues || []).length;
    if (test.expectedIssueCountMin !== undefined) {
      if (issueCount < test.expectedIssueCountMin) {
        issues.push(`issue count: expected at least ${test.expectedIssueCountMin}, got ${issueCount}`);
        passed = false;
      }
    }

    // Validate JSON structure
    if (test.shouldHaveValidRiskLevel) {
      const validLevels = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
      if (!validLevels.includes(parsed.risk_level)) {
        issues.push(`Invalid risk_level: ${parsed.risk_level}`);
        passed = false;
      }
    }

    if (test.shouldFindRBACIssue && workflow === 'kubernetes') {
      const hasRBACIssue = parsed.security_issues?.some(i => i.type === 'rbac');
      if (!hasRBACIssue) {
        issues.push('Expected RBAC issue not found');
        passed = false;
      }
    }

    if (test.shouldFindWildcard && workflow === 'iam') {
      const hasWildcardIssue = parsed.access_issues?.some(i => i.type === 'overly_broad_permissions');
      if (!hasWildcardIssue) {
        issues.push('Expected overly_broad_permissions issue not found');
        passed = false;
      }
    }

    if (passed) {
      process.stdout.write(`✅ PASS\n`);
    } else {
      process.stdout.write(`❌ FAIL\n`);
      for (const issue of issues) {
        process.stdout.write(`      ${issue}\n`);
      }
    }

    return passed;
  } catch (err) {
    process.stdout.write(`❌ ERROR: ${err.message}\n`);
    return false;
  }
}

async function runAllTests() {
  process.stdout.write('\n=== Phase A: Workflow Evaluation ===\n\n');

  let totalTests = 0;
  let passedTests = 0;

  // Run Kubernetes tests
  process.stdout.write('Workflow 2: Kubernetes Security\n');
  for (const test of tests.kubernetes) {
    totalTests++;
    if (await runTest('kubernetes', test)) {
      passedTests++;
    }
  }

  // Run IAM tests
  process.stdout.write('\nWorkflow 3: IAM Policy Audit\n');
  for (const test of tests.iam) {
    totalTests++;
    if (await runTest('iam', test)) {
      passedTests++;
    }
  }

  // Summary
  process.stdout.write(`\n=== Results ===\nPassed: ${passedTests}/${totalTests}\n`);

  if (passedTests === totalTests) {
    process.stdout.write('\n✅ All Phase A workflow tests passed!\n\n');
    process.exit(0);
  } else {
    process.stdout.write(`\n❌ ${totalTests - passedTests} test(s) failed\n\n`);
    process.exit(1);
  }
}

runAllTests().catch(err => {
  process.stderr.write(`\n❌ Test runner error: ${err.message}\n\n`);
  process.exit(1);
});
