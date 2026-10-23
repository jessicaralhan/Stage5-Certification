# Architecture Deep-Dive: Stage 5 Multi-Workflow Coordinator

---

## Design Philosophy

**Problem**: Single-workflow systems don't scale to diverse infrastructure types. Multi-agent systems need clear governance.

**Solution**: Dispatch-only Coordinator routes to independent specialized workflows, each with full 3-agent validation pipeline.

**Key Insight**: Coordinator makes routing decisions; Workflows execute independently; Report Writer synthesizes across domains.

---

## Core Design Decisions

### 1. Dispatch-Only Coordinator (vs. Execution Coordinator)

**Decision**: Coordinator has NO execution tools - only dispatch functions.

**Why**:
- Prevents coordinator from circumventing guardrails
- Coordinator can't execute arbitrary logic
- Forces clear separation: routing vs. execution
- Enables governance layer above workflows

**Evidence**:
- Coordinator prompt: `prompts/coordinator-agent.md`
- Tools available: 4 dispatch functions only
  - `launch_terraform_workflow()`
  - `launch_kubernetes_workflow()`
  - `launch_iam_workflow()`
  - `launch_report_writer()`
- No file I/O, no bash, no execution tools

**Verification**:
```bash
grep -E "launch_|tool" prompts/coordinator-agent.md
# Result: Only 4 launch_* functions defined
```

### 2. Three Independent Workflows (vs. Monolithic Pipeline)

**Decision**: Each workflow (Terraform, Kubernetes, IAM) is completely independent.

**Why**:
- Domain-specific analysis (Terraform != K8s != IAM)
- Easy to add/modify workflows without cascading changes
- Clear separation of concerns
- Prevents mega-agent problem
- Each can escalate independently

**Architecture**:
```
Workflow 1 (Terraform)    Workflow 2 (Kubernetes)    Workflow 3 (IAM)
├─ Agent 1A (Analyzer)   ├─ Agent 1B (Analyzer)    ├─ Agent 1C (Analyzer)
├─ Agent 2A (Generator)  ├─ Agent 2B (Generator)   ├─ Agent 2C (Generator)
└─ Agent 3A (Reviewer)   └─ Agent 3B (Reviewer)    └─ Agent 3C (Reviewer)
```

**Evidence**:
- 3 separate executors: terraform-executor.js, kubernetes-executor.js, iam-executor.js
- Each has identical 3-agent structure
- No cross-workflow dependencies
- Coordinator routes to exactly ONE workflow per run

### 3. Adversarial Review Isolation (vs. Sequential Review)

**Decision**: Agent 3 (Reviewer) invoked via SEPARATE API call, fresh context.

**Why**:
- Prevents Reviewer from anchoring on Generator's reasoning
- Separate API call = no message history from Agent 2
- Forces independent evaluation
- Reviewers have file access for verification, not collaboration

**Implementation**:
```javascript
// Agent 2 call
const agent2Response = await callClaude({
  user: agent2Input,
  model: 'claude-haiku-5-5',
  maxTokens: 3000,
});

// Agent 3 call - SEPARATE, no context from Agent 2
const agent3Response = await callClaude({
  user: agent3Input,  // Fresh context: findings + fixes, not agent2Response
  model: 'claude-haiku-5-5',
  maxTokens: 3000,
});
```

**Evidence**:
- Each executor makes 3 separate API calls
- Agent 3 input: `Agent1Findings + Agent2Fixes`, not `Agent2Message`
- No message history shared
- Fresh reasoning for each review

---

## Multi-Workflow Orchestration

### Execution Flow

```
1. Load Input
   ├─ Read file content
   └─ Timestamp start

2. File Type Detection
   ├─ Check extension (.tf, .yaml, .json)
   └─ Fallback to content analysis

3. Coordinator Routing
   ├─ Call Coordinator Agent
   ├─ Get decision: terraform|kubernetes|iam
   └─ Confidence level + reasoning

4. Workflow Execution (ONE of three)
   ├─ Agent 1 (Analyzer)
   │  ├─ Input: file content
   │  └─ Output: structured findings
   │
   ├─ Agent 2 (Generator)
   │  ├─ Input: findings from Agent 1
   │  └─ Output: concrete fixes
   │
   └─ Agent 3 (Reviewer)
      ├─ Input: findings + fixes
      └─ Output: verdict (APPROVE/REVISE/ESCALATE)

5. Guardrails Layer (After each agent)
   ├─ Schema validation
   ├─ Concreteness check (for Agent 2)
   └─ Hard override check (production+destructive)

6. Escalation Assessment
   ├─ Risk level evaluation
   ├─ Environment check
   ├─ Substance assessment
   └─ Escalation decision

7. Report Generation
   ├─ Call Report Writer
   └─ Generate markdown

8. Output Results
   ├─ Write JSON (findings + audit trail)
   ├─ Write Markdown (professional report)
   └─ Log escalation if needed
```

### Retry Loop with Feedback

**When Agent 3 returns "REVISE"**:

```
Agent 1 → Findings
         ↓
Agent 2 → Fixes (v1)
         ↓
Agent 3 → "REVISE" (problems identified)
         ↓
Agent 2 → Fixes (v2) + EXPLICIT CHALLENGES
         ↓
Agent 3 → Re-review
         ↓
Continue / Escalate after 2 attempts
```

**Implementation**:
- Max 2 retries per workflow
- Reviewer challenges passed as explicit context
- Escalates after failed attempts
- Documented in audit trail

---

## Guardrails Layer

### Applied BEFORE Coordinator Sees Output

**Schema Validation**:
- Agent 1 output schema: verified risk_level, findings arrays
- Agent 2 output schema: verified fixes array, concrete values
- Agent 3 output schema: verified verdict in [APPROVE, REVISE, ESCALATE]

**Concreteness Check**:
- Agent 2 (all workflows): Fixes must include exact values
  - Terraform: exact HCL snippets, not "add security"
  - Kubernetes: exact YAML, not "add security context"
  - IAM: exact policy JSON, not "restrict permissions"

**Hard Overrides**:
- Production + Destructive Changes → AUTO ESCALATE
  - No approval can override this
  - Prevents accidental production damage
  - Preserved from Stage 4

---

## Escalation Gates

### Risk Assessment Rules (6 total)

1. **CRITICAL Risk** → Always escalate
   - Severity: HIGH
   - Rationale: Unacceptable risk level

2. **HIGH Risk in Production** → Escalate
   - Severity: HIGH
   - Rationale: Production requires human approval

3. **Destructive Changes in Production** → Escalate
   - Severity: CRITICAL
   - Rationale: Infrastructure damage potential
   - Hard override (can't auto-approve)

4. **RBAC Wildcard Bindings** → Escalate
   - Severity: CRITICAL
   - Rationale: Security control bypass

5. **Wildcard IAM Permissions** → Escalate
   - Severity: CRITICAL
   - Rationale: Privilege explosion

6. **Reviewer Verdict = ESCALATE** → Escalate
   - Severity: CRITICAL
   - Rationale: Expert determination to escalate

### Substance Assessment

**Core**: Production with destructive/security issues
- Requires human approval
- Real business impact
- Billed consulting work

**Peripheral**: Non-production with findings
- Auto-approved after review
- Useful but not standalone
- Educational value

**Toy**: No significant findings
- Auto-approved
- Learning scenarios
- No production impact

---

## Stage 4 Continuity

### Inherited Guarantees

| Guarantee | How Maintained |
|-----------|---|
| Custom Harness | coordinator-harness.js (no agentic CLI) |
| Hard Overrides | escalation-gates.js checks production+destructive |
| Per-Step Evals | Each workflow runs Stage 3 tests |
| Punch-Outs Honored | Human decision gates enforced |
| Audit Trail | Per-step recording in audit_trail |

### Additional Stage 5 Guarantees

| Guarantee | Implementation |
|-----------|---|
| Dispatch-Only Coordinator | Coordinator has 4 launch_*() tools only |
| Multi-Workflow Support | 3 independent workflow executors |
| Workflow Independence | No cross-workflow data sharing |
| Adversarial Review | Agent 3 invoked via separate API call |
| Guardrails Applied | Before Coordinator sees output |
| Retry Loop | Agent 2 re-invoked with feedback |
| Report Synthesis | Report Writer generates markdown |
| Human Interface | CLI for approvals with logging |

---

## Concreteness Enforcement

### How Agent 2 is Forced to Be Concrete

**Terraform Generator Constraint**:
> "Never propose a fix that is just 'add resource limits' or 'restrict access' without a concrete value — every fix must include the actual change."

**Kubernetes Generator Constraint**:
> "Every fix must include concrete YAML or exact configuration values — never generic advice like 'add security context' without specifics."

**IAM Generator Constraint**:
> "For network policies, include specific selectors and ports, not just 'restrict traffic.'"

**Validation**:
- Agent 2 output includes `concrete_yaml_or_setting` field with ACTUAL values
- Concreteness check verifies field is not placeholder text
- Guardrails block generic advice

---

## Report Synthesis Strategy

### Multi-Workflow Report Generation

**Input**: Findings from triggered workflow(s)

**Process**:
1. Determine which workflows ran
2. Aggregate findings by type
3. Generate domain-specific sections
4. Synthesize cross-domain recommendations
5. Include audit trail appendix

**Output Format**:
```markdown
# Infrastructure & Security Review

## [Workflow 1] Infrastructure (Terraform) Findings
- Findings if Terraform workflow triggered

## [Workflow 2] Container Security (Kubernetes) Findings
- Findings if Kubernetes workflow triggered

## [Workflow 3] Access Control (IAM) Findings
- Findings if IAM workflow triggered

## Unified Recommendations
- Priority-ordered across all triggered domains

## Audit Trail Summary
- Token counts, costs, decisions
```

**Determinism**:
- Section headers based on which workflows triggered
- No random content
- Consistent structure

---

## Audit Trail Architecture

### Per-Step Recording

```json
{
  "workflow_id": "terraform",
  "correlation_id": "corr-xyz",
  "steps": [
    {
      "step": "agent1_terraform_analyzer",
      "status": "COMPLETE",
      "input_tokens": 2145,
      "output_tokens": 1890,
      "cost_usd": 0.00098,
      "findings": { /* actual findings */ }
    },
    {
      "step": "agent2_remediation_generator",
      "status": "COMPLETE",
      "input_tokens": 1500,
      "output_tokens": 2300,
      "cost_usd": 0.00145,
      "remediations": { /* actual fixes */ }
    },
    {
      "step": "agent3_adversarial_reviewer",
      "status": "COMPLETE",
      "verdict": "APPROVE",
      "escalation_flag": false
    }
  ],
  "total_tokens": 7935,
  "total_cost_usd": 0.00423,
  "timestamp": "2026-10-21T16:00:00Z"
}
```

**What's Captured**:
- Each agent's step name and status
- Token counts (input + output)
- Cost calculated from token usage
- Actual findings/fixes/verdict
- Timestamps for each step
- Escalation decisions

**Persistence**:
- Per-run JSON files in `/results/`
- Survives HTTP lifecycle
- Immutable once written
- Correlation ID for end-to-end tracing

---

## Failure Modes & Degradation

### Agent Failure
- Agent 1 failure → Workflow fails, risk_level = UNKNOWN
- Agent 2 failure → Workflow continues with Agent 1 findings only
- Agent 3 failure → Workflow escalates

### Report Writer Failure
- Fallback to basic markdown format
- Includes whatever findings available
- Human reviewable output

### Escalation Failure
- System still generates report
- Audit trail complete
- Human can review and decide

**Design Principle**: Graceful degradation, never silently fail.

---

## Performance Characteristics

### Time Complexity
- File detection: O(1)
- Coordinator routing: O(1) (single LLM call)
- Workflow execution: O(3) (3 agents, sequential)
- Report generation: O(1) (single LLM call)
- **Total**: O(3) = effectively O(1) per run

### Space Complexity
- Audit trail: O(workflow_depth) = O(3)
- Findings storage: O(findings_count)
- Report: O(findings_count)
- **Total**: O(findings_count) scales with input complexity

### Token Usage
- Per workflow: 6,000-9,000 tokens
- Report Writer: 1,000-1,500 tokens
- **Total per run**: ~8,000-10,000 tokens

### Cost
- Haiku model: ~$0.80 per 1M tokens
- Per run: ~$0.007 (0.7 cents)
- Batch of 100: ~$0.70

---

## Extensibility

### Adding a 4th Workflow

**Steps**:
1. Create agent prompts (analyzer, generator, reviewer)
2. Create workflow executor (copy template)
3. Add to WORKFLOWS map in coordinator
4. Add test scenarios
5. Add Stage 3 evaluation tests

**Time**: ~4-6 hours per new workflow

**Safety**: Existing workflows unaffected

---

## Comparison to Stage 4

| Aspect | Stage 4 | Stage 5 |
|--------|---------|---------|
| Workflows | 1 (Terraform only) | 3 (Terraform, K8s, IAM) |
| Agent Count | 3 | 9 (3 × 3) |
| Coordination | Input routing | Full dispatch + synthesis |
| Report Quality | Per-workflow | Cross-workflow synthesis |
| Extensibility | Limited | Simple (template-based) |
| Governance | Single guardrails | Per-workflow guardrails |

---

## Verification Checklist

- [x] Coordinator is dispatch-only (4 tools only)
- [x] 3 workflows completely independent
- [x] Each workflow has 3-agent pattern
- [x] Agent 3 invoked via separate API call
- [x] Guardrails applied before Coordinator sees output
- [x] Retry loop implemented with feedback
- [x] Escalation gates working correctly
- [x] Audit trail comprehensive
- [x] Report synthesis functional
- [x] Human interface available
- [x] Stage 4 continuity maintained

---

**Architecture Status**: ✅ PRODUCTION READY
**Last Updated**: 2026-10-22
