# Infrastructure Review Report: FAIL

- **Correlation ID:** exam-55dcc928-d488-4066-b7ff-5598081aa442
- **Input:** terraform-destructive.tf
- **Environment:** production
- **Status:** PENDING_HUMAN_DECISION

## Summary of Results

| Workflow | Result | Risk level | Reviewer verdict |
| --- | --- | --- | --- |
| Terraform Safety Review | FAIL | CRITICAL | APPROVE |

## Executive Summary

Thank you for the careful plan. One production change needs attention before apply.

## Terraform Safety Review: FAIL

The review of `aws_rds_cluster.prod` is complete; the CRITICAL replacement needs a human decision.

### Findings

**Risk level:** CRITICAL

| Resource | Action | Forcing attribute | Environment | Severity |
| --- | --- | --- | --- | --- |
| aws_rds_cluster.prod | destroy_and_recreate | db_subnet_group_name | production | CRITICAL |

**Cost notes**

- Replacement briefly doubles database cost during migration.

### Proposed Remediation

| Resource | Type | Proposed fix |
| --- | --- | --- |
| aws_rds_cluster.prod | process_change | Add lifecycle { create_before_destroy = true } and migrate via snapshot restore. Requires a production maintenance window and manual DBA review before apply. |

### Adversarial Review: APPROVE

Checked aws_rds_cluster.prod against the plan; verdict APPROVE.

Review rounds: 1. Source file reads by the reviewer: 1.

## Coordinator Disposition

**Disposition:** APPROVE

the coordinator tries to approve a production destructive change

**Note:** the coordinator returned APPROVE, but a deterministic gate requires a human decision, so the disposition was overridden.

## Human Review

A human decision (Continue or Reject) is required before this examination has a final disposition. Reasons:

- [CRITICAL_RISK] terraform: risk level is CRITICAL
- [HIGH_RISK_PRODUCTION] terraform: CRITICAL risk in a production environment
- [PRODUCTION_DESTRUCTIVE] terraform: 1 destructive change(s) on production resources: aws_rds_cluster.prod

Record it with: `node punch-out/human-decision-cli.js decide exam-55dcc928-d488-4066-b7ff-5598081aa442 --decision continue|reject --reviewer "Your Name"`

## Substance Assessment

| Workflow | Category | Rationale |
| --- | --- | --- |
| terraform_review | core | Pre-apply review of a Terraform plan for destructive changes, security exposure and cost impact is a recurring, billable cloud governance engagement (change-risk review before production applies). |
| kubernetes_review | core | Security review of Kubernetes manifests (RBAC, network policy, pod security) is standard paid platform-security work. |
| iam_audit | core | Least-privilege IAM policy audit is a common billable security assessment deliverable. |
| final_review_writer | peripheral | Writing up the review is required for delivery but a client would not buy report synthesis on its own; it exists to package the three core workflows. |

No elevation: no workflow is toy and fewer than two are peripheral.

## Audit Trail

Persisted at `results/exam-55dcc928-d488-4066-b7ff-5598081aa442/audit.jsonl`. 10 model calls, 10000 input tokens, 2140 output tokens, $0.020700 total (rates not yet verified against published pricing).

| Agent | Calls | Input tokens | Output tokens | Cost (USD) |
| --- | --- | --- | --- | --- |
| coordinator | 5 | 5000 | 440 | 0.007200 |
| terraform_workflow:terraform | 2 | 2000 | 600 | 0.005000 |
| adversarial_reviewer:terraform | 2 | 2000 | 600 | 0.005000 |
| final_review_writer | 1 | 1000 | 500 | 0.003500 |

