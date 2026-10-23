# Test Results

This folder contains the final test results from the Stage 5 certification project.

## Files

### Integration Test Summary
- **integration-test-results.json** - Summary of all 5 integration test scenarios
  - Status: ✅ 5/5 PASSING
  - Tests: Terraform benign, Terraform destructive, Kubernetes benign, Kubernetes RBAC, IAM wildcard
  - Each test scenario verifies routing, analysis, fix generation, and escalation

### Latest Run Example
- **run-1792763504484-output.json** - Structured findings and complete audit trail
- **run-1792763504484-report.md** - Professional markdown report

This latest run demonstrates:
- ✅ Independent coordinator routing decision
- ✅ Multi-step agent pipeline (Analyzer → Generator → Reviewer)
- ✅ Adversarial review in separate context
- ✅ Risk assessment and escalation logic
- ✅ Professional report synthesis
- ✅ Complete audit trail with tokens/costs

## Quick Review

### View Test Summary
```bash
cat integration-test-results.json | jq '.results[] | {scenario: .scenario.name, passed: .passed}'
```

### View Latest Report
```bash
cat run-1792763504484-report.md
```

### Check Coordinator Decision
```bash
cat run-1792763504484-output.json | jq '.coordinator_decision'
```

### View Audit Trail
```bash
cat run-1792763504484-output.json | jq '.workflow_findings.audit_trail'
```

## What These Results Show

✅ **Routing**: Coordinator independently analyzes and routes files correctly  
✅ **Analysis**: Agent 1 identifies issues accurately  
✅ **Remediation**: Agent 2 generates concrete fixes  
✅ **Review**: Agent 3 validates with independent verdict  
✅ **Escalation**: Critical findings properly escalated  
✅ **Reports**: Professional markdown generated  
✅ **Audit Trail**: Per-step recording with tokens/costs  

## File Sizes

| File | Size |
|------|------|
| integration-test-results.json | 2.0K |
| run-1792763504484-output.json | 22K |
| run-1792763504484-report.md | 11K |
| README.md | 2.8K |
| **Total** | **38K** |

---

**Status**: ✅ Ready for Certification Review
