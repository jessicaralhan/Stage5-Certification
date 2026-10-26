#!/usr/bin/env node

// Phase D Integration Tests: Comprehensive multi-workflow testing

require('dotenv').config({ override: true });

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Test scenarios: each tests routing, execution, reporting, and escalation
const TEST_SCENARIOS = [
  // Terraform Tests
  {
    id: 'tf-benign',
    name: 'Terraform: Properly configured infrastructure',
    input: 'test-data/terraform-benign.tf',
    environment: 'production',
    expectedWorkflow: 'terraform',
    expectedStatus: 'ESCALATED',
    expectedRisk: 'HIGH',
  },
  {
    id: 'tf-destructive',
    name: 'Terraform: Destructive change in production',
    input: 'test-data/terraform-destructive.tf',
    environment: 'production',
    expectedWorkflow: 'terraform',
    expectedStatus: 'ESCALATED',
    expectedRisk: 'CRITICAL',
  },

  // Kubernetes Tests
  {
    id: 'k8s-benign',
    name: 'Kubernetes: Properly secured manifest',
    input: 'test-data/k8s-benign.yaml',
    environment: 'production',
    expectedWorkflow: 'kubernetes',
    expectedStatus: 'ESCALATED',
    expectedRisk: 'HIGH',
  },
  {
    id: 'k8s-rbac-issue',
    name: 'Kubernetes: RBAC overly permissive (wildcard binding)',
    input: 'test-data/k8s-rbac-overly-permissive.yaml',
    environment: 'production',
    expectedWorkflow: 'kubernetes',
    expectedStatus: 'ESCALATED',
    expectedRisk: 'CRITICAL',
  },

  // IAM Tests
  {
    id: 'iam-wildcard',
    name: 'IAM: Wildcard actions and resources',
    input: 'test-data/iam-overly-broad-policy.json',
    environment: 'production',
    expectedWorkflow: 'iam',
    expectedStatus: 'ESCALATED',
    expectedRisk: 'CRITICAL',
  },
];

// Run a single scenario
async function runScenario(scenario) {
  return new Promise((resolve) => {
    process.stdout.write(`\n[Test: ${scenario.id}] ${scenario.name}\n`);
    process.stdout.write(`  Input: ${scenario.input}\n`);
    process.stdout.write(`  Environment: ${scenario.environment}\n`);

    // Let coordinator decide workflow based on input analysis (no hardcoding)
    const process_obj = spawn('node', [
      'workflow/coordinator-harness.js',
      scenario.input,
      scenario.environment,
    ]);

    let stdout = '';
    let stderr = '';

    process_obj.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process_obj.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process_obj.on('close', (code) => {
      const result = {
        scenario,
        passed: false,
        issues: [],
      };

      // Check for errors
      if (code !== 0) {
        result.issues.push(`Process exited with code ${code}`);
        if (stderr.includes('Error')) {
          result.issues.push(`Error in stderr: ${stderr.substring(0, 200)}`);
        }
      }

      // Parse output
      try {
        const runIdMatch = stdout.match(/Run ID: (\d+)/);
        if (!runIdMatch) {
          result.issues.push('Could not extract Run ID from output');
          resolve(result);
          return;
        }

        const runId = runIdMatch[1];
        const outputFile = path.join(__dirname, `../results/run-${runId}-output.json`);

        if (!fs.existsSync(outputFile)) {
          result.issues.push(`Output file not found: ${outputFile}`);
          resolve(result);
          return;
        }

        const output = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));

        // Validate routing
        if (output.workflow_type !== scenario.expectedWorkflow) {
          result.issues.push(
            `Routing mismatch: expected ${scenario.expectedWorkflow}, got ${output.workflow_type}`
          );
        }

        // Validate risk level
        if (scenario.expectedRisk && output.workflow_findings?.risk_level !== scenario.expectedRisk) {
          result.issues.push(
            `Risk level mismatch: expected ${scenario.expectedRisk}, got ${output.workflow_findings?.risk_level}`
          );
        }

        // Validate report was generated
        if (!output.report || output.report.length < 50) {
          result.issues.push('Report was not generated or too short');
        }

        // Validate escalation
        if (scenario.expectedStatus === 'ESCALATED' && output.final_status !== 'ESCALATED') {
          result.issues.push(
            `Status mismatch: expected ESCALATED, got ${output.final_status}`
          );
        }

        if (scenario.expectedStatus === 'APPROVED' && output.final_status !== 'APPROVED') {
          result.issues.push(
            `Status mismatch: expected APPROVED, got ${output.final_status}`
          );
        }

        result.passed = result.issues.length === 0;

        if (result.passed) {
          process.stdout.write(`  ✅ PASS\n`);
        } else {
          process.stdout.write(`  ❌ FAIL\n`);
          result.issues.forEach((issue) => {
            process.stdout.write(`      • ${issue}\n`);
          });
        }

        resolve(result);
      } catch (err) {
        result.issues.push(`Failed to parse results: ${err.message}`);
        process.stdout.write(`  ❌ ERROR: ${err.message}\n`);
        resolve(result);
      }
    });
  });
}

// Run all tests
async function runAllTests() {
  process.stdout.write('\n=== Phase D: Integration Test Suite ===\n');
  process.stdout.write(`Running ${TEST_SCENARIOS.length} scenarios\n`);

  const results = [];

  for (const scenario of TEST_SCENARIOS) {
    const result = await runScenario(scenario);
    results.push(result);
  }

  // Summary
  const passedCount = results.filter((r) => r.passed).length;
  const totalCount = results.length;

  process.stdout.write('\n=== Test Summary ===\n');
  process.stdout.write(`Passed: ${passedCount}/${totalCount}\n\n`);

  results.forEach((result) => {
    const status = result.passed ? '✅ PASS' : '❌ FAIL';
    process.stdout.write(`${status} ${result.scenario.id.padEnd(20)} ${result.scenario.name}\n`);

    if (!result.passed) {
      result.issues.forEach((issue) => {
        process.stdout.write(`     • ${issue}\n`);
      });
    }
  });

  // Write results to file
  const testResultsFile = path.join(__dirname, '../results/integration-test-results.json');
  fs.writeFileSync(
    testResultsFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        total: totalCount,
        passed: passedCount,
        failed: totalCount - passedCount,
        results: results,
      },
      null,
      2
    )
  );

  process.stdout.write(`\nResults saved to: ${testResultsFile}\n\n`);

  process.exit(passedCount === totalCount ? 0 : 1);
}

if (require.main === module) {
  runAllTests().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { runScenario, TEST_SCENARIOS };
