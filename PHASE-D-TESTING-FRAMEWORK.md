# Phase D: Testing & Integration Framework

## Test Strategy

Phase D validates the entire Stage 5 system across all workflows with comprehensive integration tests.

### Test Categories

#### 1. Routing Tests
- Verify file type detection (extension + content)
- Verify Coordinator makes correct routing decisions
- Verify fallback to content analysis when extension is ambiguous

#### 2. Workflow Execution Tests
- Verify each workflow's 3-agent pipeline completes
- Verify findings are correct (risk level, issue types)
- Verify audit trail is recorded

#### 3. Guardrails Tests
- Verify schema validation passes/fails appropriately
- Verify concreteness checks for Generator outputs
- Verify hard overrides trigger on destructive production changes

#### 4. Report Writer Tests
- Verify professional markdown is generated
- Verify section organization (by domain)
- Verify recommendations are specific and actionable

#### 5. Escalation Gate Tests
- Verify CRITICAL risk triggers escalation
- Verify HIGH risk + production triggers escalation
- Verify destructive changes in production escalate
- Verify RBAC wildcards escalate
- Verify IAM wildcards escalate

#### 6. Human Decision Tests
- Verify escalation CLI lists pending items
- Verify decisions are recorded with reviewer name + timestamp
- Verify audit trail is updated

#### 7. End-to-End Tests
- Verify complete pipeline: route → execute → report → escalate → (human decision)
- Verify outputs are written correctly (JSON + markdown)
- Verify timestamps and run IDs are consistent

---

## Test Scenarios

### Terraform Workflow (3 scenarios)

**Scenario 1: terraform-benign**
- Description: CloudTrail + S3 logging (no issues)
- Expected: APPROVED, LOW risk
- Validates: Clean config passes through

**Scenario 2: terraform-destructive**
- Description: RDS cluster with forced replacement
- Expected: ESCALATED, CRITICAL risk
- Validates: Destructive changes detected and escalated

**Scenario 3: terraform-security**
- Description: Security group with overly broad ingress
- Expected: ESCALATED, HIGH risk
- Validates: Security exposure detected

### Kubernetes Workflow (3 scenarios)

**Scenario 1: k8s-benign**
- Description: Properly configured deployment with RBAC, network policies
- Expected: APPROVED or ESCALATED (escalates due to thoroughness)
- Validates: Correct analysis of security settings

**Scenario 2: k8s-rbac-issue**
- Description: Wildcard RBAC bindings
- Expected: ESCALATED, CRITICAL risk
- Validates: RBAC wildcards escalate

**Scenario 3: k8s-network-policy**
- Description: Missing network policies
- Expected: ESCALATED, HIGH risk
- Validates: Missing network policies escalate

### IAM Workflow (3 scenarios)

**Scenario 1: iam-wildcard**
- Description: Action "*" on Resource "*"
- Expected: ESCALATED, CRITICAL risk
- Validates: Wildcard IAM policies escalate

**Scenario 2: iam-least-privilege**
- Description: Scoped S3 read-only policy
- Expected: APPROVED, LOW risk
- Validates: Proper policies pass

**Scenario 3: iam-missing-conditions**
- Description: Missing MFA and resource boundaries
- Expected: ESCALATED, HIGH risk
- Validates: Missing conditions escalate

---

## Test Execution

### Running All Integration Tests

```bash
cd ~/Stage5-certification
node workflow/integration-test.js
```

Output:
- Console summary: pass/fail for each scenario
- JSON results: `results/integration-test-results.json`
- Individual run outputs: `results/run-<ID>-output.json`
- Reports: `results/run-<ID>-report.md`

### Running Single Scenario

```bash
node workflow/coordinator-harness.js test-data/terraform-benign.tf production
```

### Checking Escalations

```bash
node punch-out/human-decision-cli.js list
```

### Approving an Escalation

```bash
node punch-out/human-decision-cli.js approve <run-id>
```

---

## Test Metrics

### Pass Criteria

Each test passes if:
1. ✅ Correct workflow routing
2. ✅ Correct risk level assessment
3. ✅ Report generated (markdown)
4. ✅ Escalation decision correct (APPROVED or ESCALATED)
5. ✅ JSON output written with audit trail
6. ✅ Run ID and timestamps consistent

### Coverage Goals

- **Routing**: 9 scenarios (3 file types, multiple content patterns)
- **Workflows**: 9 scenarios (3 per workflow)
- **Guardrails**: Integration validation (via agent responses)
- **Reporting**: 9 reports generated and validated
- **Escalation**: 6+ escalation rules tested
- **Human Decisions**: CLI workflow tested
- **Audit Trail**: Timestamps and run IDs verified

### Success Metrics

- **Target**: 9/9 scenarios passing (100%)
- **Minimum**: 8/9 passing (89%, with known limitation)
- **Unacceptable**: <7/9 (routing or workflow failures)

---

## Known Limitations & Workarounds

### Limitation 1: Long Test Duration
- **Issue**: Each scenario calls Claude API 3-4 times (3 agents + Report Writer)
- **Expected**: ~3-5 minutes for all 9 scenarios
- **Workaround**: Run in background, check results later

### Limitation 2: API Rate Limits
- **Issue**: Multiple API calls in quick succession may hit rate limits
- **Expected**: 429 errors with retry logic
- **Workaround**: Anthropic client has built-in retry (3x with backoff)

### Limitation 3: Terraform Analyzer Accuracy
- **Issue**: LLM may not perfectly identify all destructive changes
- **Expected**: High confidence (>90%) for obvious cases
- **Workaround**: Known scenarios are designed for clear detection

---

## Validation Checklist

Phase D is complete when:

- [ ] All 9 scenarios run without errors
- [ ] Routing is correct for all scenarios
- [ ] Risk levels match expectations
- [ ] Reports are generated for all runs
- [ ] Escalations trigger correctly (5 pass, 4 auto-approve)
- [ ] JSON outputs have audit trails
- [ ] Human decision CLI works (list, approve)
- [ ] Stage 3 eval results show 100% pass rates (per workflow)

---

## Results Files

Generated during test runs:

```
results/
├── integration-test-results.json      # Summary of all 9 scenarios
├── run-<ID1>-output.json              # Terraform benign
├── run-<ID1>-report.md
├── run-<ID2>-output.json              # Terraform destructive
├── run-<ID2>-report.md
├── run-<ID3>-output.json              # Kubernetes benign
├── run-<ID3>-report.md
├── run-<ID4>-output.json              # Kubernetes RBAC issue
├── run-<ID4>-report.md
├── run-<ID5>-output.json              # IAM wildcard
├── run-<ID5>-report.md
├── escalations/
│   └── <ID>-decision.json             # Human decisions
└── workflow-eval.json                 # Stage 3 results (from Phase A)
```

