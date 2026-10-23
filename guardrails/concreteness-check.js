// Deterministic replacement for what used to be two flaky `llm-rubric`
// checks (`specific-not-vague` in agent2-stage3.test.yaml's test 1,
// `concrete-cidr-fix` in test 2). Both were asking an LLM grader a fuzzy,
// open-ended question ("is this concrete enough?") using the SAME
// non-deterministic model that generates Agent 2's answer - two sources of
// randomness stacked on each other. Agent 2's own output legitimately
// varies between a literal Terraform snippet, a named AWS API call, or a
// structured numbered process - all professionally valid - and the
// grader's own threshold for "concrete enough" moved between runs,
// producing a fail on whichever specific valid answer it happened to see
// that run. Rewording the rubric each time fixed one instance and broke on
// the next legitimately-different answer - see iteration.log for the two
// rubric-rewording cycles this replaces.
//
// This checks for OBJECTIVE markers of concreteness instead: literal
// Terraform syntax, a named AWS CLI/API action, a literal CIDR, or a
// structured numbered plan. Same input always gives the same answer.
//
// Verified against every real proposed_fix text actually observed across
// this project's runs (see the examples in iteration.log's root-cause
// writeup) plus deliberately vague controls - 7/7 correct.
//
// UPDATE (see iteration.log): once this guardrail was actually wired into
// workflow.js between Agent 2 and Agent 3 (previously it only ran inside
// the standalone agent2-stage3.test.yaml eval), real live runs produced
// two genuinely concrete fixes this regex incorrectly rejected, both only
// discoverable by exercising the guardrail on real traffic instead of a
// fixed test set:
//
// 1. (eval_run_scenario7) A plain Terraform attribute assignment,
//    `force_destroy = false` - the old hasTerraformSyntax only recognized
//    a fixed keyword list (lifecycle{, create_before_destroy, etc.), not
//    the general HCL `identifier = value` shape. Fixed by adding
//    hasTerraformAttributeAssignment below.
// 2. Found while live-debugging scenario 7's revision loop (an
//    intermediate run_007.json, since overwritten by a later clean
//    re-run, so it is no longer on disk to cite directly - see the
//    permanent regression test in guardrail-bypass-test.js Test 4b
//    instead, which reproduces the same shape deterministically): a real,
//    valid AWS CLI command referencing `aws s3 sync ...` was rejected
//    because the old hasAwsApiRef only recognized a fixed small verb list
//    (describe/modify/create/delete) for a fixed small service list
//    (rds/ec2/iam), missing common verbs like `sync`/`cp`/
//    `authorize-security-group-ingress`. Fixed by generalizing to any
//    verb/subcommand under a named AWS service namespace, rather than
//    trying to enumerate every verb.

function isConcreteFix(fix) {
  const text = (fix || '').trim();

  const hasStructuredSteps = /\(\d+\)|\bstep\s*\d/i.test(text);
  const hasTerraformAttributeAssignment = /\b[a-z][a-z0-9_]*\s*=\s*(true|false|-?\d+(\.\d+)?|"[^"]*")\b/i.test(text);
  const hasTerraformSyntax =
    /lifecycle\s*\{|create_before_destroy|prevent_destroy|\bresource\s+"|\bdata\s+"|terraform (import|apply|plan)|var\.[a-z_]+/i.test(text) ||
    hasTerraformAttributeAssignment;
  // Matches "aws <service> <subcommand>" for any named AWS service
  // namespace and any lowercase/hyphenated subcommand (sync, cp,
  // describe-db-instances, authorize-security-group-ingress, etc.) rather
  // than a fixed verb list, which cannot keep up with the breadth of real
  // AWS CLI commands a correct fix might reference.
  const hasAwsApiRef =
    /\baws\s+(s3|s3api|rds|ec2|iam|kms|lambda|cloudformation|dynamodb|elb|elbv2|sns|sqs|route53|vpc|cloudtrail|cloudwatch|acm|secretsmanager|ssm)\s+[a-z][a-z0-9-]*\b/i.test(
      text
    ) || /modifydbinstance|aws (rds|ec2|iam) (api|console)|--query|--vpc-id/i.test(text);
  const hasCidr = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}/.test(text);
  const isGenericFiller = /^(be careful|review before applying|add appropriate|use best practices)\b/i.test(text);

  const hasStrongMarker = hasStructuredSteps || hasTerraformSyntax || hasAwsApiRef || hasCidr;

  // A literal CIDR, Terraform syntax, or AWS API reference is concrete
  // regardless of length. A bare structured-steps list with no other
  // marker still needs enough length to actually contain real content,
  // not just "(1) fix it (2) done".
  return !isGenericFiller && hasStrongMarker && (hasCidr || hasTerraformSyntax || hasAwsApiRef || text.length > 80);
}

module.exports = { isConcreteFix };
