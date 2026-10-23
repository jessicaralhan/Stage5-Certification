// Offline, executable proof for punch-out-test-evidence.md. Needs no API key.
// Run with:
//   node punch-out/bypass-test.js
// Prints PASS/FAIL for each check. Exits non-zero on any failure.

const { evaluateRiskGate } = require("./risk-gate");

function assert(label, condition) {
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}`);
  if (!condition) process.exitCode = 1;
}

const findingsProd = {
  destructive_changes: [{ resource: "aws_db_instance.orders_prod", environment: "production", severity: "CRITICAL" }],
  security_exposure: [],
  risk_level: "CRITICAL",
};
const findingsSafe = { destructive_changes: [], security_exposure: [], risk_level: "LOW" };
const findingsNonProdRevise = {
  destructive_changes: [],
  security_exposure: [{ resource: "x", severity: "MEDIUM", environment: "non-production" }],
  risk_level: "MEDIUM",
};
const approveClean = {
  verdict: "APPROVE",
  verdict_reasoning: "Remediation is valid.",
  reviewed_remediations: [{ resource: "x", technically_valid: true, actually_resolves_issue: true, requires_human_signoff: false }],
};

console.log("=== Test 1: normal punch-out (prod destructive change, verdict ESCALATE) ===");
const verdictEscalate = { verdict: "ESCALATE", verdict_reasoning: "Production DB replacement requires DBA sign-off." };
const gate1 = evaluateRiskGate(findingsProd, verdictEscalate, 0, "production");
assert("gate decision is PUNCH_OUT", gate1.decision === "PUNCH_OUT");
console.log(`  reason: ${gate1.reason}\n`);

console.log("=== Test 2: BYPASS ATTEMPT - verdict manually forced to APPROVE ===");
const verdictForcedApprove = { verdict: "APPROVE", verdict_reasoning: "(forced) looks fine", reviewed_remediations: [] };
const gate2 = evaluateRiskGate(findingsProd, verdictForcedApprove, 0, "production");
assert("hard override still blocks it (decision is PUNCH_OUT, not APPROVED)", gate2.decision === "PUNCH_OUT");
assert("reason cites the hard override, not the AI verdict", gate2.reason.includes("Hard override"));
console.log(`  reason: ${gate2.reason}\n`);

console.log("=== Test 3: control - safe change should NOT punch out ===");
const gate3 = evaluateRiskGate(findingsSafe, approveClean, 0, "non-production");
assert("gate decision is APPROVED for a genuinely safe case", gate3.decision === "APPROVED");
console.log(`  reason: ${gate3.reason}\n`);

console.log("=== Test 4: revision loop cap - repeated REVISE eventually escalates ===");
const verdictRevise = { verdict: "REVISE", verdict_reasoning: "fix incomplete", reviewed_remediations: [] };
const gateLoop1 = evaluateRiskGate(findingsNonProdRevise, verdictRevise, 0, "non-production");
const gateLoop2 = evaluateRiskGate(findingsNonProdRevise, verdictRevise, 1, "non-production");
const gateLoop3 = evaluateRiskGate(findingsNonProdRevise, verdictRevise, 2, "non-production");
assert("loop 1 (reviseCount=0) returns REVISE", gateLoop1.decision === "REVISE");
assert("loop 2 (reviseCount=1) returns REVISE", gateLoop2.decision === "REVISE");
assert("loop 3 (reviseCount=2, hit MAX_REVISE_LOOPS) escalates instead of looping forever", gateLoop3.decision === "PUNCH_OUT");
console.log();

console.log("=== Test 5: operator says production, Agent 1 mislabels the change non-production ===");
const mislabeled = {
  destructive_changes: [{ resource: "aws_db_instance.orders_prod", environment: "non-production", severity: "HIGH" }],
  security_exposure: [],
  risk_level: "HIGH",
};
const gate5 = evaluateRiskGate(mislabeled, approveClean, 0, "production");
assert("production run is punched out even when Agent 1 labels the change non-production", gate5.decision === "PUNCH_OUT");
console.log(`  reason: ${gate5.reason}\n`);

console.log("=== Test 6: unrecognised environment label fails closed (counts as production) ===");
const unlabelled = {
  destructive_changes: [{ resource: "aws_db_instance.orders", severity: "HIGH" }],
  security_exposure: [],
  risk_level: "HIGH",
};
const gate6 = evaluateRiskGate(unlabelled, approveClean, 0, "non-production");
assert("destructive change with no environment label is punched out", gate6.decision === "PUNCH_OUT");
console.log();

console.log("=== Test 7: production CRITICAL/HIGH security exposure cannot be approved by the model alone ===");
const prodSecurity = {
  destructive_changes: [],
  security_exposure: [{ resource: "aws_security_group.web", severity: "HIGH", environment: "production" }],
  risk_level: "HIGH",
};
const gate7 = evaluateRiskGate(prodSecurity, approveClean, 0, "production");
assert("production HIGH security exposure is punched out even when Agent 3 APPROVEs", gate7.decision === "PUNCH_OUT");
assert("reason names the security hard override", gate7.reason.includes("security exposure"));
console.log(`  reason: ${gate7.reason}\n`);

console.log("=== Test 8: Agent 3 APPROVE with requires_human_signoff=true is escalated ===");
const signoffApprove = {
  verdict: "APPROVE",
  verdict_reasoning: "Looks fine.",
  reviewed_remediations: [{ resource: "x", technically_valid: true, actually_resolves_issue: true, requires_human_signoff: true }],
};
const gate8 = evaluateRiskGate(findingsNonProdRevise, signoffApprove, 0, "non-production");
assert("sign-off flag overrides an APPROVE verdict", gate8.decision === "PUNCH_OUT");
console.log(`  reason: ${gate8.reason}\n`);

console.log("=== Test 9: Agent 3 APPROVE but technically_valid=false is sent back for revision ===");
const invalidApprove = {
  verdict: "APPROVE",
  verdict_reasoning: "Looks fine.",
  reviewed_remediations: [{ resource: "x", technically_valid: false, actually_resolves_issue: true, requires_human_signoff: false }],
};
const gate9 = evaluateRiskGate(findingsNonProdRevise, invalidApprove, 0, "non-production");
assert("an invalid remediation under APPROVE returns REVISE, not APPROVED", gate9.decision === "REVISE");
console.log(`  reason: ${gate9.reason}\n`);
