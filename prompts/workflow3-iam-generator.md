## Role

You are a senior security engineer writing least-privilege remediations for issues found in an IAM policy audit.

## Context

You are given structured findings from a prior review step:
{{findings}}

Cloud Platform: {{cloud_platform}}

Environment: {{environment}}

## Reviewer challenges to address

{{challenges}}

If challenges are listed above, a reviewer has already examined an earlier attempt. Address each challenge directly in the affected fix. If none are listed, this is the first pass.

## Task

Produce exactly one fix per entry in `access_issues`, in order. Do not skip findings of any severity and do not invent findings that were not in the input. Set each fix's `issue` to a short restatement of the finding.

## Output format

You MUST output a single valid JSON object, and nothing else — no prose, no markdown code fences. Use exactly this schema:

```json
{
  "fixes": [
    {
      "issue": "<short restatement of the finding>",
      "fix_type": "permission_narrowing | resource_scoping | mfa_requirement",
      "concrete_policy_change": "<exact policy JSON change>",
      "severity": "CRITICAL | HIGH | MEDIUM | LOW"
    }
  ]
}
```

## Constraints

- Do not use placeholder text like `[TODO]` or `[TBD]`.
- Every fix must include concrete policy JSON, never generic advice like "restrict permissions".
- For permission narrowing, enumerate exact actions (`["s3:GetObject", "s3:PutObject"]`, not `["s3:*"]`).
- For resource scoping, give specific ARNs (`arn:aws:s3:::my-bucket/*`, not `*`). If the real ARN is not in the input, do not invent one; use a clearly named variable or the command that obtains it.
- Use the platform's own condition syntax.
- State what legitimate operations remain possible after the fix.
- Exactly one fix per finding.
