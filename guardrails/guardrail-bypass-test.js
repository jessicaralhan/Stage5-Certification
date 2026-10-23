// Real, executable proof that the between-step guardrails actually block
// bad handoffs — closing a gap flagged in certification review: all 12
// real workflow runs on disk happen to have valid==true on every guardrail
// check, so the blocking path was architecturally real but never observed
// firing. This feeds each guardrail deliberately malformed/non-concrete
// input — the kind a hallucinating or compromised agent could produce —
// and asserts it is rejected, the same way punch-out/bypass-test.js proves
// the risk gate's hard override.
//
// Run with: node guardrails/guardrail-bypass-test.js
// This file's actual stdout is what gets pasted into
// guardrails/guardrail-bypass-evidence.md, not hand-typed text.

const { validateAgent1Output, validateAgent2Output, validateAgent3Output } = require("./schema-validation");
const { isConcreteFix } = require("./concreteness-check");

function assert(label, condition) {
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}`);
  if (!condition) process.exitCode = 1;
}

console.log("=== Test 1: Agent 1 hallucinated/malformed JSON is rejected ===");
const badAgent1 = { destructive_changes: "not-an-array", risk_level: "SUPER_BAD" };
const a1Check = validateAgent1Output(badAgent1);
assert("schema-validation rejects a non-array destructive_changes field", !a1Check.valid);
assert("schema-validation rejects an invalid risk_level enum value", a1Check.errors.some((e) => e.includes("risk_level")));
console.log(`  errors: ${JSON.stringify(a1Check.errors)}\n`);

console.log("=== Test 2: Agent 2 placeholder/[TODO] output is rejected by schema-validation ===");
const badAgent2Placeholder = { remediations: [{ resource: "aws_db_instance.x", proposed_fix: "[TODO] fill this in later" }] };
const a2SchemaCheck = validateAgent2Output(badAgent2Placeholder);
assert("schema-validation rejects a [TODO] placeholder proposed_fix", !a2SchemaCheck.valid);
console.log(`  errors: ${JSON.stringify(a2SchemaCheck.errors)}\n`);

console.log("=== Test 3: Agent 2 vague-but-well-formed output is rejected by concreteness-check ===");
console.log("  (This is the case schema-validation alone CANNOT catch — the JSON is well-formed,");
console.log("  long enough, and has no [TODO] marker, but contains no objective technical content.)");
const vagueFix = "Please be careful and review this change thoroughly before applying it to make sure everything is okay and nothing breaks in production.";
const vagueRemediation = { remediations: [{ resource: "aws_db_instance.orders_prod", proposed_fix: vagueFix }] };
const a2SchemaOnly = validateAgent2Output(vagueRemediation);
assert("schema-validation alone WOULD have let this through (proves concreteness-check is not redundant)", a2SchemaOnly.valid);
assert("concreteness-check correctly rejects it as non-concrete", !isConcreteFix(vagueFix));
console.log(`  fix text: "${vagueFix}"\n`);

console.log("=== Test 4: Agent 2 genuinely concrete output is correctly accepted ===");
const concreteFix = "Apply lifecycle { create_before_destroy = true } and run `aws rds describe-db-instances --db-instance-identifier orders-prod-db` to confirm the new instance is healthy before removing the old one.";
assert("concreteness-check correctly accepts real Terraform + AWS CLI content", isConcreteFix(concreteFix));
console.log(`  fix text: "${concreteFix}"\n`);

console.log("=== Test 4b: regression tests for two real false negatives found in live runs ===");
console.log("  (see iteration.log — both were only discovered once this guardrail ran on real traffic)");
const terraformAttrFix = "Set force_destroy to false to prevent accidental data loss: force_destroy = false";
assert("a plain Terraform attribute assignment (force_destroy = false) is accepted, not just known keywords", isConcreteFix(terraformAttrFix));
const awsSyncFix = "Migrate data to the new bucket first using aws cli sync: aws s3 sync s3://old-bucket-name s3://new-bucket-name, then apply the Terraform change.";
assert("an 'aws s3 sync' command is accepted, not just the original describe/modify/create/delete verb list", isConcreteFix(awsSyncFix));
const genericAwsProse = "The aws is a great cloud, we should use aws more carefully in production because aws can be risky sometimes if not reviewed.";
assert("generic prose that merely mentions 'aws' repeatedly is still correctly rejected (no false positive)", !isConcreteFix(genericAwsProse));

console.log("=== Test 5: Agent 3 invalid verdict enum is rejected ===");
const badAgent3 = { reviewed_remediations: [], verdict: "LOOKS_FINE_I_GUESS" };
const a3Check = validateAgent3Output(badAgent3);
assert("schema-validation rejects a verdict outside APPROVE|REVISE|ESCALATE", !a3Check.valid);
console.log(`  errors: ${JSON.stringify(a3Check.errors)}\n`);

console.log("=== Test 6: well-formed, concrete, valid-verdict output passes every guardrail ===");
const goodAgent1 = { destructive_changes: [{ resource: "x", severity: "LOW" }], security_exposure: [], risk_level: "LOW" };
const goodAgent2 = { remediations: [{ resource: "x", proposed_fix: concreteFix }] };
const goodAgent3 = { reviewed_remediations: [{ resource: "x" }], verdict: "APPROVE" };
assert("valid Agent 1 output passes", validateAgent1Output(goodAgent1).valid);
assert("valid + concrete Agent 2 output passes both guardrails", validateAgent2Output(goodAgent2).valid && isConcreteFix(goodAgent2.remediations[0].proposed_fix));
assert("valid Agent 3 output passes", validateAgent3Output(goodAgent3).valid);
