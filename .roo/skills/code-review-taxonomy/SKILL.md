---
name: code-review-taxonomy
description: 8-category taxonomy scan for pre-merge diff review (code-reviewer Stage 1). Classifies findings as correctness/security/stability/data-integrity/performance/maintainability/test-coverage/style-docs with P0-P3 severity and 0-100 confidence.
modeSlugs:
    - code-reviewer
    - orchestrator-crow
---

# Code Review Taxonomy

> Pre-merge semantic diff review. Trigger: code-reviewer Stage 1, after the Stage 0 quality-gate scan.

## 1. Purpose

This skill is Stage 1 of the code-reviewer 4-stage pipeline. It turns a raw diff into normalized, severity-rated findings the rest of the pipeline can filter and count. It prevents the 13 most common semantic-review failures:

1. **Duplicating Stage 0**: re-running build/lint/type/test checks the deterministic scan already covered.
2. **Context creep**: reviewing unchanged files and flooding output with pre-existing issues.
3. **Vague findings**: "this looks off" with no file, line, or evidence.
4. **Severity inflation**: marking style nits as blockers, hiding real P0 items.
5. **Severity deflation**: downgrading a P0 so the verdict reads PASS.
6. **Confidence guessing**: reporting numbers with no stated basis.
7. **One root cause, three findings**: duplicate records for the same defect.
8. **Fixing while reviewing**: applying edits instead of returning findings (audit-only role).
9. **Security tunnel vision**: either skipping security patterns or treating every security hit as a full security-reviewer cycle.
10. **Category drift**: labeling a data-loss bug as "style" because the diff touched formatting.
11. **Lockfile noise**: findings on vendored, generated, or lock files.
12. **Verdict shopping**: re-scanning with loosened rules until the count reads zero.
13. **Bikeshedding**: reporting style, formatting, or naming issues the Stage 0 linter or formatter already flags, or proposing personal-preference refactors that match existing codebase conventions. Not a finding; spend the review budget on correctness.

## 2. Scope & Boundaries

- **Read-only**: findings and recommendations only. Never edit, never commit. Fixes route back to developer or coding agents.
- **Diff Scope Guard**: If the diff exceeds one rigorous pass (guide: more than 50 files or 2000 changed lines), stop and report that the scope needs splitting instead of shallow-passing.
- **Intent Conformance**: The delegation payload carries the change's purpose and success criteria. Enumerate each criterion and verify the diff implements it. Missing or partial required logic is a correctness finding at P1: absent logic outranks wrong logic. If the payload carries no intent statement, note "No intent statement provided; omission check skipped."
- **Changed files only**: findings attach to added/modified lines in the diff. Unchanged code is context, never a finding target.
- **Auto-skip**: vendored code, generated code, lockfiles, minified assets. List them under "Skipped" in the report, never review them.
- **Stage separation**: Stage 0 (quality-gate, scoped to QG-01/02/03/04/10/12/13 + QG-14) owns deterministic checks. This stage owns semantic judgment. Do not re-run builds, tests, lint, or formatters.
- **Pipeline position**: Stage 2 applies the confidence filter (keep ≥75, security bypasses) and Stage 3 handles learning handoff. This stage emits raw normalized findings; it does not filter, verdict, or hand off.

## 3. The 8 Categories

Every finding lands in exactly one category. Pick by defect, not by the file's dominant topic.

| #   | Category        | Scan focus                                                                                                                                                                                                                                                          |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | correctness     | Logic errors, off-by-one, inverted conditions, wrong operators, dead branches, broken invariants, API contract misuse, wrong return handling                                                                                                                        |
| 2   | security        | Injection, broken authn/authz, secret exposure, unsafe deserialization, path traversal, SSRF, crypto misuse, missing input validation on trust boundaries                                                                                                           |
| 3   | stability       | Crash paths, unhandled errors/panics, race conditions, deadlocks, resource leaks, missing awaits, unhandled rejections, lifecycle misuse (init/build/dispose)                                                                                                       |
| 4   | data-integrity  | Validation gaps, transaction boundaries, migration safety, idempotency, partial-failure data loss, type/coercion mismatches at storage or API boundaries, backward compatibility (breaking public API request/response shapes, rollback-unsafe database migrations) |
| 5   | performance     | Superlinear complexity, N+1 queries, needless allocations/copies, blocking I/O on hot paths, unbounded growth, missing pagination                                                                                                                                   |
| 6   | maintainability | Dead code, duplicated logic, oversized functions, leaky abstractions, names/structure that hide intent                                                                                                                                                              |
| 7   | test-coverage   | Changed logic without tests, missing edge cases (empty/null/max/concurrency), assertions that cannot fail, mocks that mirror the implementation                                                                                                                     |
| 8   | style-docs      | Formatting, naming-convention drift, comments/docs that no longer match the code, missing doc updates tied to the diff                                                                                                                                              |

## 4. Severity (P0-P3)

| Emoji | Severity | Meaning                                                                                         | Merge effect                   |
| ----- | -------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| 🔴    | P0       | Defect or exposure that must block merge: data loss, security hole, crash, broken core behavior | Verdict REJECT, zero tolerance |
| 🟠    | P1       | Real defect or high-risk gap, no safe default; fix before merge                                 | Verdict CONDITIONAL at best    |
| 🟡    | P2       | Should fix; explicit per-finding author waiver allowed                                          | CONDITIONAL with waiver        |
| 🟢    | P3       | Polish: style, docs, minor maintainability                                                      | Does not block                 |

Severity comes from impact, not from how easy the fix is. One hunk can hold several severities; record each separately.

## 5. Confidence (0-100)

Integer 0-100, assigned per finding with this rubric:

| Band   | Label     | Bar                                                                          |
| ------ | --------- | ---------------------------------------------------------------------------- |
| 90-100 | Proven    | Exact code path traced; provable from the diff plus surrounding source alone |
| 75-89  | Strong    | Clear evidence in the diff; at most one stated assumption                    |
| 50-74  | Plausible | Pattern matches a known defect shape; key context not verified               |
| 0-49   | Guess     | Not reportable; convert into a question for the author                       |

Caps: max 89 without tracing the exact path. Reserve 95-100 for diff-alone proof. Stage 2 drops everything below 75 except the security category.

## 6. Security Handling (Bypass + Handoff)

- Any finding in the security category sets `handoff: security-reviewer`, regardless of confidence.
- Security findings are never dropped by the Stage 2 numeric filter.
- This stage does not run a full security review. It flags, rates severity, and hands off. `security-reviewer` owns the security verdict (conditional confirmation pass).
- Mark likely-false-positive security patterns as confidence ≤74 with `handoff: none`; record the reasoning so `security-reviewer` does not re-triage blind.

## 7. Scan Procedure

1. **Scope & Intent Check**: Verify diff against Diff Scope Guard (>50 files or >2000 lines triggers split recommendation). Verify intent conformance against the delegation payload criteria; mark missing requirements as P1 correctness findings.
2. Load the diff: orchestrator payload or `git diff <base>...HEAD`. Enumerate changed files; auto-skip the §2 list.
3. For each remaining file, read the diff hunks plus surrounding context (about ±20 lines where needed). When the diff changes a public contract (exported signature, interface, event or message name, config key, schema field, default value), search (e.g. `grep_search`) the repository for all callers and usages; a caller the diff breaks is a finding attributed to the diff hunk.
4. Run all 8 category lenses over each hunk. Record every candidate as a finding record (§8).
5. Assign severity (§4) and confidence (§5) to each candidate.
6. Set `handoff` per §6 for security-category records.
7. Deduplicate: same root cause becomes one finding, keeping the highest severity; note merged IDs.
8. Order output P0 first, then P1, P2, P3; within a severity, by confidence descending.
9. Emit the Stage 1 report (§9). Stop. No fixes, no commits, no re-scans.

## 8. Finding Record Schema

```
[F-NN]
category: correctness | security | stability | data-integrity | performance | maintainability | test-coverage | style-docs
severity: P0 | P1 | P2 | P3 (with emoji)
confidence: 0-100
file: <path>
lines: L<start>-L<end>
title: <one line, defect + location implied>
evidence: <snippet or traced path; enough to verify without re-running the scan>
recommendation: <one line; direction only, no patch>
handoff: security-reviewer | none
```

A finding without `file`, `lines`, `evidence`, or `confidence` is incomplete. Reject it before it reaches the report.

## 9. Output (Stage 1 Report)

```markdown
## Stage 1 Taxonomy Scan Report

### Scope: <base>...<head>, N files, M hunks

### Findings: K total | P0: a | P1: b | P2: c | P3: d | security handoff: h

| ID   | Sev   | Category    | Conf | File:Lines       | Title |
| ---- | ----- | ----------- | ---- | ---------------- | ----- |
| F-01 | 🔴 P0 | correctness | 92   | src/x.ts:L40-L55 | ...   |

### Finding Details

[F-01] ... (full record per §8)

### Skipped: <vendored/generated/lock files>

### Author Questions: <sub-75 confidence items converted to questions, security excluded>
```

The verdict (PASS / CONDITIONAL / REJECT) is computed by the `code-reviewer` agent from this report plus Stage 0 output, not by this skill.
