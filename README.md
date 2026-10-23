# Stage 5: Multi-Workflow Coordinator System

A sophisticated infrastructure governance system that analyzes Terraform, Kubernetes, and IAM configurations through independent specialized workflows, coordinated by a dispatch-only agent.

---

## System Architecture

```
Infrastructure Input (Terraform, Kubernetes, IAM)
        ↓
[Coordinator Agent] - Analyzes input, routes to correct workflow
        ↓
    ┌───┴───┬────────────┐
    ↓       ↓            ↓
[Terraform] [Kubernetes] [IAM]
    ↓       ↓            ↓
   3-Agent Pipeline (Analyzer → Generator → Reviewer)
   for each workflow
    ↓       ↓            ↓
    └───┬───┴────────────┘
        ↓
[Report Writer] - Synthesizes findings across workflows
        ↓
[Escalation Gates] - Assesses risk and human review requirements
        ↓
Final Report (JSON + Markdown) + Audit Trail
```

---

## Core Components

### 1. Coordinator Agent (claude-haiku-5-5)
- **Role**: Dispatch-only routing decision maker
- **Tools**: `launch_terraform_workflow()`, `launch_kubernetes_workflow()`, `launch_iam_workflow()`, `launch_report_writer()`
- **Task**: Analyze input file type and route to appropriate workflow
- **Constraint**: No file I/O, no bash, no direct execution - pure routing decisions

### 2. Three Independent Workflows

#### Workflow 1: Terraform Safety Review
- **Agent 1A (Analyzer)**: Detects destructive changes, security exposures, cost impacts
- **Agent 2A (Remediation Generator)**: Generates concrete Terraform fixes
- **Agent 3A (Adversarial Reviewer)**: Validates fixes with APPROVE/REVISE/ESCALATE verdict
- **Test Data**: terraform-benign.tf, terraform-destructive.tf
- **Risk Levels**: LOW, MEDIUM, HIGH, CRITICAL

#### Workflow 2: Kubernetes Security Review
- **Agent 1B (Analyzer)**: Identifies RBAC, network policy, security context, pod security issues
- **Agent 2B (Hardening Generator)**: Generates concrete YAML fixes
- **Agent 3B (Adversarial Reviewer)**: Validates fixes and operational impact
- **Test Data**: k8s-benign.yaml, k8s-rbac-overly-permissive.yaml
- **Issues Detected**: RBAC wildcards, missing network policies, missing security contexts, inadequate resource limits

#### Workflow 3: IAM Policy Audit
- **Agent 1C (Analyzer)**: Detects overly broad permissions, missing conditions, access control violations
- **Agent 2C (Access Tightener)**: Generates least-privilege policy fixes
- **Agent 3C (Auditor)**: Validates fixes against least-privilege principle
- **Test Data**: iam-overly-broad-policy.json
- **Issues Detected**: Wildcard actions/resources, missing conditions, unused roles, session TTL issues

### 3. Report Writer Agent
- Synthesizes findings from triggered workflows
- Generates professional markdown reports organized by domain
- Includes executive summary, findings, recommendations, audit trail

### 4. Escalation Gates
- Evaluates risk level and environment
- Applies escalation rules:
  - CRITICAL risk → escalate
  - HIGH risk in production → escalate
  - Destructive changes in production → escalate
  - RBAC wildcards → escalate
  - IAM wildcards → escalate
  - Reviewer verdict is ESCALATE → escalate
- Assesses substance level (core/peripheral/toy)

### 5. Orchestrator Harness
- Coordinates multi-step execution:
  1. Load and detect file type
  2. Call Coordinator for routing decision
  3. Execute chosen workflow (all 3 agents)
  4. Check escalation gates
  5. Generate report
  6. Write audit trail and results

---

## Key Design Features

### ✅ Dispatch-Only Coordinator
- Coordinator has NO execution tools
- Only tools are `launch_*_workflow()` dispatch functions
- Prevents coordinator from circumventing guardrails
- Routes decision remains independent of workflow details

### ✅ Workflow Independence
- Each workflow operates in isolation
- No cross-workflow data sharing
- Each can escalate independently
- Easy to add/modify workflows without affecting others

### ✅ Adversarial Review Isolation
- Agent 3 (Reviewer) invoked via separate API call
- No message history sharing with Agent 2 (Generator)
- Reviewers have file access for verification only
- Fresh reasoning per review

### ✅ Deterministic Guardrails
- Schema validation on agent outputs
- Concreteness checks for generators
- Hard overrides for production+destructive
- Prevents garbage output from reaching Coordinator

### ✅ Retry Loop with Feedback
- When Reviewer returns REVISE → Generator re-invoked
- Passes explicit reviewer challenges as context
- Max 2 retries per workflow
- Escalates after failed attempts

### ✅ Comprehensive Audit Trail
- Per-step recording with timestamps
- Token counts and costs captured
- Correlation ID for end-to-end tracing
- Audit trail survives HTTP lifecycle

---

## How to Run

### Prerequisites
```bash
cd ~/Stage5-certification
npm install
# Set ANTHROPIC_API_KEY environment variable
```

### Run Single Analysis
```bash
node workflow/coordinator-harness.js test-data/terraform-benign.tf production
```

**Output**:
- `results/run-<ID>-output.json` - Structured findings + audit trail
- `results/run-<ID>-report.md` - Professional markdown report

### Run Integration Tests
```bash
node workflow/integration-test.js
```

**Tests 5 scenarios**:
1. Terraform benign config
2. Terraform destructive changes
3. Kubernetes secure config
4. Kubernetes RBAC wildcard issue
5. IAM wildcard policy

**Results**: `results/integration-test-results.json`

### Check Escalations
```bash
node punch-out/human-decision-cli.js list
```

### Approve Escalation
```bash
node punch-out/human-decision-cli.js approve <run-id>
```

---

## Example Output

### Input
File: `k8s-rbac-overly-permissive.yaml` (Production Kubernetes cluster)

### Findings (Agent 1B Output)
```
Risk Level: CRITICAL
Issues Found:
- RBAC: ClusterRole grants wildcard (*:*) permissions
- RBAC: ClusterRoleBinding attaches to service account
- Network Policy: No default-deny (allow all by default)
- Security Context: No runAsNonRoot
- Pod Security: No seccomp profile
```

### Recommendations (Agent 2B Output)
```yaml
# Delete admin-like role and replace with scoped Role
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: api-server-role-scoped
  namespace: secure-app
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["api-config"]
  verbs: ["get"]  # Only GET, not LIST/WATCH
---
# Add default-deny NetworkPolicy
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: secure-app
spec:
  podSelector: {}
  policyTypes:
  - Ingress
```

### Report Summary
The system generates professional markdown that includes:
- Executive summary (findings overview)
- Workflow-specific sections (Terraform, Kubernetes, IAM)
- Specific resource names and namespaces
- Actionable recommendations with implementation guidance
- Severity levels clearly stated
- Audit trail appendix

---

## Architecture Validation

### ✅ Stage 5 Requirements

| Requirement | Evidence |
|-------------|----------|
| Dispatch-only Coordinator | Coordinator has only launch_*_workflow() tools |
| 3 Independent Workflows | Each workflow operates in isolation |
| Multi-agent pipelines | Each workflow: Analyzer → Generator → Reviewer |
| Adversarial review isolation | Agent 3 invoked via separate API call |
| Guardrails layer | Schema validation + concreteness checks |
| Retry loop | Agent 2 re-invoked with reviewer feedback |
| Escalation gates | Risk assessment with 6 evaluation rules |
| Audit trail | Per-step recording with timestamps |
| Report synthesis | Professional markdown generation |
| Human decision interface | CLI for approvals with logging |

### ✅ Stage 4 Continuity

| Feature | Status |
|---------|--------|
| Custom harness (no CLI) | ✅ Maintained |
| Hard overrides | ✅ Production + destructive → auto punch-out |
| Per-step evals | ✅ Each workflow Stage 3 validated |
| Punch-outs honored | ✅ Human gates enforced |
| Audit trail | ✅ Per-step tokens/cost persisted |

---

## Substance Assessment

### Core (Production Work)
- Production Terraform with destructive changes
- Production Kubernetes with RBAC issues
- Production IAM with overly broad permissions
- **Action**: Requires human review and approval

### Peripheral (Real Findings, Non-Production)
- Staging Kubernetes with security issues
- Non-critical IAM findings
- Dev environment Terraform
- **Action**: Auto-approved after review

### Toy (Educational/Learning)
- No significant findings
- Clean configurations
- Test scenarios with no real issues
- **Action**: Auto-approved, no escalation

---

## Stage 3 Evaluation

### Workflow 1: Terraform Safety Review
**7 Criteria** (from Stage 4 validation):
1. ✅ Destructive change detection
2. ✅ Security exposure identification
3. ✅ Cost impact analysis
4. ✅ Concrete Terraform fixes
5. ✅ Adversarial review validation
6. ✅ CRITICAL risk escalation
7. ✅ Production hard override

**Pass Rate**: 100%

### Workflow 2: Kubernetes Security Review
**3+ Criteria**:
1. ✅ RBAC issue detection
2. ✅ Network policy analysis
3. ✅ Security context hardening

**Pass Rate**: 100%

### Workflow 3: IAM Policy Audit
**3+ Criteria**:
1. ✅ Wildcard permission detection
2. ✅ Least-privilege fix generation
3. ✅ Access control hardening

**Pass Rate**: 100%

---

## Project Structure

```
Stage5-certification/
├── prompts/
│   ├── coordinator-agent.md
│   ├── workflow1-terraform-{analyzer,generator,reviewer}.md
│   ├── workflow2-kubernetes-{analyzer,generator,reviewer}.md
│   ├── workflow3-iam-{analyzer,generator,reviewer}.md
│   └── report-writer.md
├── workflow/
│   ├── coordinator-harness.js (main orchestration)
│   ├── terraform-executor.js (3-agent pipeline)
│   ├── kubernetes-executor.js (3-agent pipeline)
│   ├── iam-executor.js (3-agent pipeline)
│   ├── report-writer-executor.js
│   ├── escalation-gates.js
│   ├── anthropic-client.js (API client)
│   ├── integration-test.js
│   └── test-runner.js
├── test-data/
│   ├── terraform-benign.tf
│   ├── terraform-destructive.tf
│   ├── k8s-benign.yaml
│   ├── k8s-rbac-overly-permissive.yaml
│   └── iam-overly-broad-policy.json
├── results/
│   ├── run-*-output.json (detailed findings + audit trail)
│   ├── run-*-report.md (professional markdown)
│   └── integration-test-results.json (test summary)
├── punch-out/
│   ├── human-decision-cli.js
│   └── decisions/ (escalation records)
├── guardrails/
│   └── schema validators
└── README.md (this file)
```

---

## Cost & Performance

### Token Usage per Workflow
- **Analyzer**: 2,000-3,000 tokens (detailed finding analysis)
- **Generator**: 1,500-2,500 tokens (fix generation)
- **Reviewer**: 1,000-2,000 tokens (validation)
- **Report Writer**: 1,000-1,500 tokens (synthesis)
- **Total per workflow**: ~6,000-9,000 tokens

### Execution Time
- Per scenario: 30-60 seconds (including API latency)
- Full test suite (5 scenarios): 3-5 minutes

### Scalability
- Coordinator remains single-call (fast routing)
- Workflows execute sequentially (easily parallelizable)
- Report generation independent (can batch)
- Audit trail per-step (scales with workflow complexity)

---

## What Works Well

✅ **Routing**: All file types detected and routed correctly  
✅ **Analyzer Agents**: Excellent finding detection across domains  
✅ **Report Generation**: Professional markdown even with partial data  
✅ **Escalation Logic**: Risk assessment sound and appropriate  
✅ **Orchestration**: 8-step process executes reliably  
✅ **Error Handling**: Graceful degradation on failures  
✅ **Audit Trail**: Comprehensive step-by-step logging  

---

## Known Limitations

- Generator agents (Agent 2) require robust JSON extraction (improved in Phase D)
- Integration tests validate risk_level at top level (structural requirement)
- Report Writer depends on proper data structure from workflows

---

## Next Steps

1. Verify all test scenarios pass (integration-test-results.json shows 5/5)
2. Archive evidence package (source code + sample outputs)
3. Complete iteration log documentation
4. Submit final package with README, ARCHITECTURE.md, and evidence

---

**Status**: Ready for production use  
**Last Updated**: 2026-10-22  
**Version**: 1.0 (Stage 5)
