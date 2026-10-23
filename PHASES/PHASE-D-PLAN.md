# Phase D: Testing & Integration - Execution Plan

## Overview

Phase D validates the entire Stage 5 multi-workflow system through comprehensive integration testing.

**Timeline**: 5 scenarios running in parallel (via sequential orchestrator calls)  
**Expected Duration**: ~10-15 minutes total (3-4 min per scenario with API calls)  
**Status**: Tests running in background

---

## Integration Test Scenarios

### Terraform Workflow Tests (2 scenarios)

#### Test 1: Benign Configuration
- **File**: `terraform-benign.tf`
- **Content**: CloudTrail + S3 logging setup
- **Expected Path**:
  1. File detection → terraform (file ext + resource blocks)
  2. Coordinator confirms → terraform routing
  3. Workflow: Agent 1A analyzes → LOW risk (no issues)
  4. Report Writer → generates markdown
  5. Escalation gate → NO (benign, auto-approve)
  6. Status → APPROVED

- **Validates**: Clean workflows pass without escalation

#### Test 2: Destructive Change
- **File**: `terraform-destructive.tf`
- **Content**: RDS cluster with forced replacement (subnet group change)
- **Expected Path**:
  1. File detection → terraform
  2. Coordinator → terraform routing
  3. Workflow: Agent 1A → detects destructive change (CRITICAL)
  4. Report Writer → documents forced replacement risk
  5. Escalation gate → YES (destructive + production)
  6. Status → ESCALATED (requires human approval)

- **Validates**: Destructive changes escalate correctly

### Kubernetes Workflow Tests (2 scenarios)

#### Test 3: Benign Manifest
- **File**: `k8s-benign.yaml`
- **Content**: Secure deployment with RBAC, network policies, security context
- **Expected Path**:
  1. File detection → kubernetes (yaml + apiVersion/kind)
  2. Coordinator → kubernetes routing
  3. Workflow: Agent 1B → thorough analysis (HIGH risk found due to strictness)
  4. Report Writer → professional K8s-domain report
  5. Escalation gate → might escalate (HIGH risk), depends on substance
  6. Status → APPROVED or ESCALATED (acceptable either way)

- **Validates**: Kubernetes workflows execute correctly

#### Test 4: RBAC Wildcard Issue
- **File**: `k8s-rbac-overly-permissive.yaml`
- **Content**: ServiceAccount bound to wildcard admin-like ClusterRole
- **Expected Path**:
  1. File detection → kubernetes
  2. Coordinator → kubernetes routing
  3. Workflow: Agent 1B → detects wildcard RBAC (CRITICAL)
  4. Agent 2B → generates hardening fixes
  5. Agent 3B → reviews fixes (verdict = ESCALATE)
  6. Report Writer → documents RBAC risk
  7. Escalation gate → YES (wildcard RBAC detected)
  8. Status → ESCALATED

- **Validates**: RBAC wildcard detection and escalation

### IAM Workflow Test (1 scenario)

#### Test 5: Wildcard Policy
- **File**: `iam-overly-broad-policy.json`
- **Content**: AWS policy with Action "*" on Resource "*"
- **Expected Path**:
  1. File detection → iam (json + IAM policy structure)
  2. Coordinator → iam routing
  3. Workflow: Agent 1C → detects wildcard (CRITICAL)
  4. Agent 2C → generates least-privilege fixes
  5. Agent 3C → reviews (verdict = ESCALATE)
  6. Report Writer → documents access risk
  7. Escalation gate → YES (wildcard IAM detected)
  8. Status → ESCALATED

- **Validates**: IAM policy analysis and escalation

---

## Validation Checklist

### Routing (Tests 1-5)
- [ ] File type detection from extension
- [ ] Content analysis when needed
- [ ] Coordinator confirms routing
- [ ] Correct workflow executor called

### Workflow Execution (Tests 1-5)
- [ ] Agent 1 produces findings with risk level
- [ ] Agent 2 produces fixes (if issues found)
- [ ] Agent 3 produces verdict (if escalation needed)
- [ ] Audit trail recorded per step

### Report Generation (Tests 1-5)
- [ ] Markdown generated for each run
- [ ] Domain-specific sections included
- [ ] Findings organized by type
- [ ] Recommendations are specific

### Escalation Gates (Tests 2, 4, 5)
- [ ] Destructive changes escalate
- [ ] RBAC wildcards escalate
- [ ] IAM wildcards escalate
- [ ] Substance assessment correct

### Final Status (All tests)
- [ ] APPROVED for clean runs
- [ ] ESCALATED for risky runs
- [ ] Reasoning clear in output

### Output Files (All tests)
- [ ] JSON output: run-<ID>-output.json
- [ ] Markdown report: run-<ID>-report.md
- [ ] Run ID and timestamp consistent
- [ ] Audit trail complete

---

## Success Criteria

**Phase D passes if**:
1. ✅ All 5 scenarios complete without crashes
2. ✅ Routing correct for all scenarios
3. ✅ Risk assessment matches expectations
4. ✅ Reports generated for each run
5. ✅ Escalations trigger when expected
6. ✅ Stage 3 eval results (from Phase A/B/C) show 100% pass rates

**Result**: `integration-test-results.json` with 5/5 passing

---

## Real-Time Progress

As tests run:
- Each scenario creates: `run-<ID>-output.json` + `run-<ID>-report.md`
- Summary created: `integration-test-results.json` (when all complete)
- Escalations stored: `escalations/<ID>-decision.json` (if human review needed)

## Next Steps (After Completion)

1. Review integration test results
2. If all pass → Proceed to Phase E (Evidence & Documentation)
3. If failures → Debug and re-run specific scenarios
4. Document any deviations from expected behavior

