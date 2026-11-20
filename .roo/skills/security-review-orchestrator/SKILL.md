---
name: security-review-orchestrator
description: >
    Orchestrates multi-pass security review cycles: self-review, specialized tooling, and external assessment. Manages remediation loops and re-validation workflows.
---

# Security Review Orchestrator

## 1. Purpose

The Security Review Orchestrator coordinates the full security review cycle for a change, from intake through threat modeling, review passes, finding triage, remediation, retest, and the final release verdict. It is a risk-based framework, not a fixed checklist.

The orchestrator is responsible for:

1. **Identify the system and change** under review — repository, branch, base and current revisions, artifact, and environment.
2. **Identify assets and trust boundaries** — what is protected, who is trusted, and where trust ends.
3. **Create a threat model** — assets, actors, entry points, invariants, and abuse cases specific enough to drive the review plan.
4. **Classify change risk** — LOW / MEDIUM / HIGH / CRITICAL based on impact and attack surface, not file count.
5. **Select review passes** — choose from Pass 0 through Pass 5 based on risk, change characteristics, and org policy; never default to "run everything."
6. **Define pass scope, tools, environment, and approval** — record what each pass verifies, what it does not, where it runs, and what authorization it has.
7. **Normalize findings to a common model** — map output from every source (manual review, SAST, SCA, DAST, external assessor) into one schema.
8. **Merge duplicates and reconcile conflicts** — link findings by root cause, endpoint, or invariant; resolve contradictory tool results with evidence.
9. **Distinguish false positives from real risk** — require code-path verification, reachability analysis, and reviewer rationale before dismissing anything.
10. **Assess severity, exploitability, confidence, and priority** — keep technical severity, fix priority, and confidence as separate dimensions.
11. **Create remediation specifications with verification conditions** — each finding gets a root cause, required invariant, recommended change, prohibited shortcuts, and a retest plan.
12. **Track fix state** — move findings through the lifecycle with rationale, actor, and timestamp on every transition.
13. **Retest original exploits and variants** — re-run the original detector or an equivalent, then search for related attack paths.
14. **Judge the release gate** based on the current revision and artifact — never on stale evidence or an older build.
15. **Create a safe scope and handoff for external assessment** — define targets, allowed and prohibited techniques, accounts, and reporting terms.
16. **Handle security reports and sensitive data safely** — redact secrets and PII, restrict access, and honor contractual handling terms.

## 2. Role Boundaries

| Role                                     | Responsibilities                                                                                                                                                          | Boundaries                                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestrator** (this skill)            | Define scope, build threat model, plan review passes, select tools and reviewers, normalize findings, track remediation, coordinate retests, issue release recommendation | Does not implement fixes. Does not modify code to make its own findings disappear.                                                                                                                 |
| **Reviewer**                             | Review source, configuration, dependencies, infrastructure, and test evidence within the allowed scope; report findings with evidence                                     | Does not expand scope, does not run unauthorized tests, does not fix findings it discovers.                                                                                                        |
| **Remediation** (`code` / `debug` modes) | Implement fixes per the remediation specification, add security tests, verify with the defined retest plan                                                                | Separate role from the orchestrator. The orchestrator never modifies production code, security rules, tests, or scanner configuration to pass its own findings.                                    |
| **External Assessment**                  | Independent assessor or approved external service performing authorized testing and producing a report                                                                    | The orchestrator does not perform the external assessment itself. Do not mark external assessment as completed if it was not actually done. Do not claim to have performed an external assessment. |

Configurable role names: in the existing workflow, the orchestrator is the **VP**, remediation is delegated to **code** / **debug** modes, and intent verification is handled by **ask**. Replace these names as the workflow requires.

## 3. When to Use

Trigger a security review when any of the following applies:

- Major feature or milestone completion
- Release candidate preparation
- Production deployment preparation
- Authentication, authorization, or tenant isolation changes
- Secret, credential, or token changes
- Public API or internet-facing endpoint changes
- Payment or PII handling changes
- File upload or download changes
- Filesystem or command execution changes
- Serializer, parser, or deserializer changes
- Database migration
- Dependency or lockfile changes
- CI/CD, release, or signing changes
- Container, IaC, or cloud IAM changes
- External integration or webhook changes
- Cryptography changes
- Post-security-incident review
- Periodic security review (per org policy)
- Explicit user audit request
- Retest of a previously remediated finding

## 4. Trigger Model

Do not use fixed rules like "every week," "every month," or "every 5 batches." Combine two trigger types:

**Event-Based** — immediate risk assessment when a change touches:

- Authentication, authorization, tenant isolation
- Credentials, tokens, secrets
- Public surface (new or changed internet-facing endpoints)
- Parser, deserializer, or input interpretation
- Command execution, filesystem access
- File upload/download
- Payment or financial data
- Personal data
- Database migration
- Dependencies or lockfiles
- CI/CD, release, or signing
- Infrastructure, containers, cloud IAM
- Security configuration (CORS, CSP, headers, rate limits)
- Cryptography
- Sensitive logging or error disclosure

**Time-Based** — per org policy. Examples (defaults only, never hard rules):

- Diff-focused review per high-risk batch
- Full-repo tooling monthly or per release cycle
- Independent assessment annually, at major releases, or at trust-boundary changes

Fixed cycles are defaults only. Repository or org policy takes precedence when it defines different cadence.

## 5. Security Review Intake

Record the intake as YAML before any review work:

```yaml
review_id: SEC-REV-2026-001
system: <system or service name>
repository: <repo path or URL>
branch: <branch under review>
base_revision: <commit SHA of baseline>
current_revision: <commit SHA under review>
artifact: <build artifact ID or digest, if any>
environment: <dev / test / staging / production>
deployment_target: <where this change will deploy>
change_summary: <one-paragraph description of the change>
changed_components: [<component>, <component>]
data_classification: <public / internal / confidential / restricted / PII>
external_interfaces: [<endpoint or integration>]
authenticated_roles: [<role>, <role>]
high_value_assets: [<asset>, <asset>]
applicable_policies: [<policy or standard>]
previous_review: <review_id or null>
known_findings: [<finding_id>]
authorized_test_level: <read-only / dynamic-in-test / dynamic-in-staging / approved-production>
out_of_scope: [<item>, <item>]
constraints: [<time, budget, environment, legal constraints>]
```

Rules:

- Mark `SCOPE_CONFIDENCE: LOW` when the baseline, artifact, or environment is unclear. A review on an unclear scope is INCONCLUSIVE, not PASS.
- If the source under review differs from the deployed artifact (e.g., release branch vs. built binary), specify each separately with its own revision and digest.

## 6. Scope Baseline

The review scope includes, as applicable:

- Base → HEAD committed changes
- Staged and unstaged changes
- Untracked non-ignored files
- Dependency and lockfile delta
- Generated artifacts
- Migrations
- CI workflows
- IaC definitions
- Container image definitions
- Deployment configuration
- Secrets and config references (not the secret values themselves)
- External service contracts
- Deployed artifact digest
- Runtime environment configuration

Do not limit scope to "modified source files only." Security impact includes configuration, infrastructure, dependencies, and deployment state. A one-line config change can be HIGH risk; a 500-line internal refactor can be LOW risk.

## 7. Threat Modeling

Build a minimum threat model before running checks. It must be specific enough to determine the review plan — it does not need to be a massive document.

Minimum contents:

- **Assets** — data and capabilities worth protecting
- **Actors** — users, roles, services, external parties
- **Entry points** — endpoints, inputs, webhooks, files, CLI, APIs
- **Trust boundaries** — where trust level changes (e.g., internet → app, app → DB, user → admin)
- **Privileged operations** — actions that require elevated rights
- **Sensitive data** — PII, credentials, tokens, financial data
- **Security invariants** — properties that must always hold
- **Abuse cases** — ways an attacker could misuse the system
- **External dependencies** — third-party services, libraries, infrastructure
- **Assumptions** — what is assumed safe and why
- **Unknowns** — what is not yet known and needs investigation

Security invariant examples:

- Tenant A cannot access tenant B data
- Unauthenticated callers cannot perform state-changing operations
- Secrets are not exposed in clients or logs
- Untrusted input is not interpreted as shell
- Uploaded files stay within the approved storage boundary
- Payment operations are idempotent
- Webhooks only accept verified senders

## 8. Risk Classification

Classify by impact and attack surface, not by file count or lines changed.

| Level        | Examples                                                                                                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LOW**      | Documentation, non-security UI or internal changes, test-only changes, limited refactor with no public surface                                                                                                                                                                |
| **MEDIUM**   | General business logic, authenticated internal endpoints, general configuration, non-sensitive persistence, UI/API contract changes                                                                                                                                           |
| **HIGH**     | Auth/authz, tenant isolation, credentials, public endpoints, file handling, command execution, payment, PII, migrations, dependency/CI-CD, cloud IAM, crypto, unsafe/native code, parser/deserializer, webhooks, privileged admin                                             |
| **CRITICAL** | Production credentials, remote code execution surface, cross-tenant data access, payment movement, release signing, production data deletion, root/admin control plane, the security control itself being changed, regulated core data, broad internet-exposed attack surface |

## 9. Review Passes

Passes are selected per review, not fixed to three. Pass 0 is always required; the rest are selected by risk, change characteristics, and org policy.

### Pass 0: Scope and Threat Modeling (REQUIRED)

Record scope, revision, assets, trust boundaries, invariants, risk classification, review plan, and authorization boundaries. No checks run before this pass is complete.

### Pass 1: Diff-Focused Secure Code Review

Required for all code-changing security reviews. Review:

- Changed source and its callers
- Configuration changes
- Tests (are security-relevant paths tested?)
- Dependency delta
- Permission changes
- Error and logging changes
- Data flow across the change
- Trust-boundary changes

Track data flow, not just string search. A dangerous sink reached through a new path is a finding even if the sink line is unchanged.

### Pass 2: Repository and Supply-Chain Tooling

Select applicable tools only:

- SAST
- SCA (dependency vulnerability scanning)
- Secret scanning
- License/policy checks
- Dependency provenance
- IaC scanner
- Container scanner
- Configuration scanner
- Source history secret scan
- SBOM generation
- Binary/artifact scan

Do not run all tools unconditionally. Select by language, repository, risk, and org policy.

### Pass 3: Dynamic and Adversarial Validation

When applicable:

- Security integration tests
- Negative tests
- API security tests
- DAST
- Fuzzing
- Property-based tests
- Malformed input handling
- Auth matrix tests
- Session lifecycle tests
- Rate-limit tests
- Upload/path handling tests
- Migration rollback tests
- Concurrency/race tests

Default environment: isolated test or staging. See Production Testing Policy for anything else.

### Pass 4: Independent External Assessment

Consider or require when:

- Major release
- Large architecture change
- New trust boundary
- Regulatory or contractual requirement
- High-risk internet-facing feature
- Periodic independent assessment (per org policy)
- Retest of a previous critical finding

Do not auto-require external assessment for every patch release.

### Pass 5: Release Evidence Review

Review, against the current commit and artifact:

- Outstanding findings
- Accepted risks
- Remote results (external assessment, if any)
- Deployment configuration
- Rollback plan
- Monitoring and alerting
- Incident readiness
- Final gate judgment

## 10. Review Planning

For each selected pass, record a plan:

```yaml
pass_id: P1
objective: <what this pass must verify>
scope: <files, components, endpoints, config>
reviewer_or_tool: <reviewer role or tool name>
version: <tool version or reviewer identity>
environment: <local / test / staging / production>
authorization: <what is explicitly approved>
data_shared: <what data leaves the environment>
network_activity: <none / outbound to specific hosts>
mutation_risk: <none / writes to test data / writes to prod>
commands: [<exact commands to run>]
evidence: <where results are recorded>
blocking_policy: <what this pass can block>
timeout: <max duration>
```

Do not just list tool names. Record what each tool verifies and what it does not verify, so gaps are visible.

## 11. Tool Resolution

Resolve tools in this priority order:

1. Repository security workflow (if defined)
2. Org policy and approved tools
3. Repository configuration
4. Ecosystem official or widely-verified tools
5. Manual review
6. `NOT_RUN` or `MANUAL_REVIEW` if no means is available

Rules:

- Do not auto-install new security products.
- Do not upload source to external services without verifying the service's data handling.
- Before using any tool, verify: local vs. SaaS, source upload behavior, data retention, secret transmission possibility, authentication, cost, license, network scan behavior, mutation risk, required permissions, tool version, configuration, and suppression/baseline files.

## 12. Safe Tool Execution

Default mode is **read-only**. Without explicit approval, do not:

- Run active scans against production
- Execute exploits
- Use destructive payloads
- Run DoS tests
- Perform credential stuffing or password spraying
- Perform social engineering
- Exfiltrate data
- Install persistence
- Simulate malware
- Lock out accounts
- Create or delete cloud resources
- Upload source to external services
- Rewrite repo history
- Auto-fix dependencies
- Auto-add scanner suppressions
- Relax security controls

Check the working tree and environment state before and after every tool execution. Any unexpected change must be reported and reverted before continuing.

## 13. Production Testing Policy

Default dynamic test environment priority:

1. Disposable local environment
2. Test container
3. Isolated integration environment
4. Dedicated staging
5. Approved shared test environment
6. Limited approved production (last resort)

Production testing requires **all** of the following, in writing:

- Explicit written approval
- Exact target
- Allowed techniques
- Prohibited techniques
- Start and end times
- Test accounts
- Data handling policy
- Traffic limits
- Stop conditions
- Rollback/recovery plan
- Incident contact
- Monitoring coordination
- Result retention policy

Do not plan or execute production testing without approval.

## 14. External Assessment Policy

Handoff to an external assessor includes:

- Target and environment
- In-scope assets
- Out-of-scope assets
- Allowed attack types
- Prohibited attack types
- Test accounts and roles
- Data handling and privacy terms
- Production restrictions
- Social engineering: always OUT_OF_SCOPE without separate written approval
- Availability testing terms
- Reporting format
- Finding severity model
- Retest conditions
- Disclosure rules
- Emergency contacts
- Legal authorization

Do not report external assessment results as completed if the report has not actually been received. Use `PLANNED`, `SCHEDULED`, `IN_PROGRESS`, or `NOT_COMPLETED` as appropriate.

## 15. Security Coverage Domains

Select domains by change characteristics, not by applying everything:

- Authentication
- Authorization
- Tenant isolation
- Session/token lifecycle
- Input validation
- Injection
- XSS
- CSRF
- SSRF
- Path traversal
- File upload/download
- Command execution
- Deserialization
- Data exposure
- Logging/error disclosure
- Secret management
- Cryptography
- CORS/CSP/security headers
- Rate limiting
- Abuse prevention
- Business logic
- Payment
- Idempotency
- Concurrency/race conditions
- DoS
- Dependency/supply chain
- CI/CD
- Artifact integrity
- Container
- IaC
- Cloud IAM
- Database/migration
- Privacy/retention
- Mobile/desktop
- Native/unsafe code
- Webhook/event signature
- Observability
- Rollback/incident readiness

Do not apply all domains to every project. Select based on the threat model and change scope.

## 16. Authorization Matrix Testing

For auth-impacting changes, test the matrix:

| Actor                   | Target           | Operation               | Expected                         |
| ----------------------- | ---------------- | ----------------------- | -------------------------------- |
| Unauthenticated         | Any resource     | Read/write              | Deny or explicit public behavior |
| Authenticated user      | Self             | Permitted operation     | Allow                            |
| Authenticated user      | Other user       | Protected operation     | Deny                             |
| Tenant user             | Same tenant      | Scoped operation        | Per policy                       |
| Tenant user             | Other tenant     | Any protected operation | Deny                             |
| Admin                   | Authorized scope | Privileged operation    | Allow                            |
| Downgraded/revoked user | Prior resource   | Privileged operation    | Deny                             |

Adapt to actual system roles. Do not check only the happy path — also check the deny path and stale credentials.

## 17. Finding Normalization

Normalize all findings to a common schema:

```yaml
id: <finding id>
fingerprint: <stable hash for dedup>
title: <short title>
source: <manual / tool / external assessor>
pass: <P0-P5>
tool_or_reviewer: <name>
tool_version: <version>
revision: <commit SHA>
artifact: <artifact digest>
environment: <where observed>
affected_component: <component>
asset: <asset>
trust_boundary: <boundary crossed>
category: <OWASP-style category>
cwe: <CWE id if known>
evidence: <log, trace, output, code reference>
reproduction: <steps to reproduce>
attack_prerequisites: <what attacker needs>
reachability: <reachable from entry point? how>
impact: <what breaks if exploited>
likelihood: <how likely>
exploitability: <how easy>
severity: <CRITICAL / HIGH / MEDIUM / LOW / INFO>
priority: <P0-P4>
confidence: <CONFIRMED / HIGH / MEDIUM / LOW / UNKNOWN>
status: <lifecycle state>
owner: <remediation owner>
remediation: <remediation spec reference>
verification_plan: <how to verify the fix>
related_findings: [<ids>]
sensitive_report: <true/false — requires restricted handling>
```

Do not guess CWE if unclear. Leave it empty rather than inventing a number.

## 18. Severity, Priority and Confidence

Keep all three separate. They answer different questions.

**Severity** (technical/business damage if exploited): `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, `INFO`

**Priority** (fix order): `P0` (immediate), `P1` (current cycle), `P2` (next cycle), `P3` (tracked), `P4` (hardening)

**Confidence** (finding accuracy): `CONFIRMED`, `HIGH`, `MEDIUM`, `LOW`, `UNKNOWN`

Evaluation factors:

- Internet exposure
- Auth prerequisite
- Required privilege
- User interaction
- Runtime reachability
- Exploit maturity
- Data sensitivity
- Affected tenant/user count
- Integrity/availability impact
- Detection difficulty
- Compensating controls
- Reproducibility

Use CVSS or the org standard as a reference, not as a replacement for business risk judgment.

## 19. Deduplication and Correlation

Merge or link findings when they share:

- Same source/sink
- Same code location
- Same endpoint
- Same root cause
- Same vulnerable dependency
- Same trust-boundary violation
- Same exploit path
- Same security invariant

Correlation states: `UNIQUE`, `DUPLICATE`, `RELATED`, `VARIANT`, `COMMON_ROOT_CAUSE`

Rules:

- Do not auto-raise severity because multiple tools found the same issue.
- Do not auto-dismiss as false positive because only one tool found it.

## 20. False-Positive Triage

Closing a finding as a false positive requires:

- Code path or configuration verification
- Runtime reachability analysis
- Sanitizer/validator verification
- Permission boundary verification
- Tool rule vs. actual behavior comparison
- Minimal reproduction if needed
- Reviewer rationale
- Current revision

Triage states: `CONFIRMED_FINDING`, `LIKELY_FINDING`, `NEEDS_VALIDATION`, `FALSE_POSITIVE`, `ACCEPTED_TOOL_LIMITATION`

Do not close a finding as a false positive just because "it is unlikely to be exploited now." That is a risk acceptance decision, not an FP decision.

## 21. Finding Lifecycle

States: `NEW`, `TRIAGED`, `DUPLICATE`, `FALSE_POSITIVE`, `ACCEPTED_RISK`, `REMEDIATION_PLANNED`, `IN_PROGRESS`, `READY_FOR_RETEST`, `VERIFIED_FIXED`, `PARTIALLY_FIXED`, `REGRESSION`, `DEFERRED`, `BLOCKED`, `CLOSED`

`CLOSED` may only be reached from: `VERIFIED_FIXED`, `FALSE_POSITIVE`, `ACCEPTED_RISK`, `DUPLICATE`

Every state change records: rationale, actor, timestamp.

## 22. Remediation Specification

Each finding gets a remediation spec:

```yaml
finding_id: <id>
objective: <what the fix must achieve>
root_cause: <why the vulnerability exists>
affected_paths: [<paths>]
required_security_invariant: <the invariant the fix restores>
recommended_change: <what to change>
prohibited_shortcuts: [<list>]
regression_test: <test that fails before, passes after>
negative_test: <test of the forbidden path>
variant_search: <related locations to check>
compatibility: <impact on existing behavior>
migration: <data or config migration needed>
owner: <remediation owner>
due_policy: <deadline per severity policy>
retest_pass: <which pass re-verifies>
```

Prohibited shortcuts:

- Disabling scanner rules
- Broad suppressions
- Skipping tests
- Swallowing errors
- Removing security controls
- Moving validation to the client only
- Relying on UI-only auth
- Logging without masking
- Ignoring dependency audit results
- Blocking only the exact exploit string
- Patching only the specific payload

## 23. Security Test Requirements

Security fixes should include, when applicable:

- Regression test (fails before, passes after)
- Negative test
- Unauthorized/forbidden path test
- Boundary value test
- Malformed input test
- Alternate encoding test
- Related endpoint/variant test
- Stale/revoked credential test
- Concurrency/replay test
- Cleanup/rollback test
- Logging redaction test

Not all findings need integration tests. Use the appropriate combination: unit, integration, contract, E2E, fuzz, property-based, static assertion, config test, infra policy test, manual exploit reproduction, or external retest.

## 24. Retest Loop

```
FINDING
  → TRIAGE
  → ROOT CAUSE
  → REMEDIATION SPEC
  → IMPLEMENTATION
  → SECURITY TESTS
  → GENERAL REGRESSION
  → ORIGINAL DETECTOR OR EQUIVALENT RETEST
  → VARIANT SEARCH
  → CURRENT REVISION CHECK
  → CLOSURE DECISION
```

Prefer re-running the same pass. Allow equivalent validation when:

- The original tool is unavailable
- The rule produces false positives
- External assessor retest is scheduled separately
- A stronger reproduction test exists

Record the equivalent evidence and the residual risk when substituting validation.

## 25. Evidence Freshness

Every result is linked to:

- Repository
- Branch
- Commit SHA
- Working-tree state
- Artifact digest
- Environment
- Configuration
- Tool version
- Scan timestamp

Mark evidence `STALE` when any of the following changes:

- Source
- Dependency
- Lockfile
- Security config
- Infrastructure
- Container
- Migration
- Scanner config
- Suppression/baseline files
- Deployment artifact

Do not approve a release on stale evidence.

## 26. Severity Response Policy

Prefer org policy over fixed SLAs. Default guidance when no policy exists:

| Severity     | Default response                                                |
| ------------ | --------------------------------------------------------------- |
| **CRITICAL** | Block release, immediate triage, prioritize exposure mitigation |
| **HIGH**     | Default block, fix in current release cycle                     |
| **MEDIUM**   | Block or track per release risk                                 |
| **LOW**      | Track, cumulative risk review                                   |
| **INFO**     | Hardening or observation                                        |

Adjust by: active exploitation, public exploit availability, internet exposure, data sensitivity, compensating controls, patch complexity, rollback possibility, regulatory deadlines, customer commitments.

## 27. Risk Acceptance and Waiver

```yaml
finding_id: <id>
reason: <why acceptance is justified>
business_owner: <who accepts the risk>
security_approver: <who approves from security side>
scope: <what the acceptance covers>
compensating_controls: [<controls that reduce risk>]
residual_risk: <what remains after controls>
expiry: <date or condition>
review_date: <next review>
remediation_plan: <plan to eventually fix>
```

Default **NO waiver** for:

- Known auth bypass
- Cross-tenant data access
- Exposed production credential
- Confirmed RCE
- Uncontained data loss
- Release signing compromise
- Destructive migration without recovery
- Active exploitation

Even if legally or organizationally possible, the AI does not auto-approve waivers. Waivers require a human business owner and security approver.

## 28. Report Confidentiality

- Do not write secret or credential originals in reports. Reference them by ID or location.
- Record exploit payloads at minimum necessary scope.
- Redact PII.
- Limit sharing of sensitive endpoint and architecture details to the needed scope.
- Verify external tool upload policies before use.
- Restrict report access to named reviewers.
- Do not post detailed exploits in public issues.
- Verify no tokens appear in screenshots or logs.
- Pass only the information remediation owners need.
- Honor contractual handling terms for external assessor reports.

## 29. Release Gate Decision

Verdicts:

| Verdict                     | Conditions                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PASS**                    | All required passes done; evidence on current revision/artifact; no unresolved blocking findings; no stale evidence; required remediation retests done; environment differences within tolerance |
| **PASS_WITH_ACCEPTED_RISK** | Remaining findings explicitly approved with approver, scope, expiry, and compensating controls; no Critical or prohibited findings; residual risk clear                                          |
| **FAIL**                    | Unresolved blocking findings; required security invariant failure; unapproved High/Critical risk; required pass failed; dangerous scope expansion or unauthorized testing                        |
| **INCONCLUSIVE**            | Required tool/environment unavailable; scope or revision unclear; evidence stale; external test incomplete; artifact/source mismatch; FP triage incomplete; report incomplete                    |
| **NOT_READY_FOR_REVIEW**    | Scope or artifacts not stable                                                                                                                                                                    |

Do not use a single ambiguous "CONDITIONAL PASS" state.

## 30. External Assessment Status

States: `NOT_REQUIRED`, `PLANNED`, `SCHEDULED`, `IN_PROGRESS`, `REPORT_RECEIVED`, `RETEST_REQUIRED`, `COMPLETED`, `BLOCKED`

- Do not auto-require an external pen test for every production release.
- If org policy, regulation, contract, or risk level requires it, do not approve the release until it is completed.

## 31. Workflow Integration

```
IMPLEMENTATION COMPLETES
  → SECURITY REVIEW INTAKE
  → THREAT MODEL AND RISK CLASSIFICATION
  → REQUIRED PASSES
  → FINDING TRIAGE
  → REMEDIATION LOOP
  → RETEST
  → SECURITY RELEASE VERDICT
  → GENERAL RELEASE GATE
```

- A general code-quality gate PASS cannot override a security gate FAIL.
- A security gate PASS does not replace functional correctness or overall release readiness.

## 32. Report Format

Structured markdown report:

1. **Verdict** — one sentence
2. **Review Target** — review ID, repo, branch, base, current, artifact, environment, deployment, scope confidence
3. **Change and Risk Summary** — components, data classification, external interfaces, risk level, required passes, out-of-scope
4. **Threat Model** — assets, actors, entry points, trust boundaries, invariants, abuse cases, assumptions
5. **Review Passes table** — pass, scope, reviewer/tool, version, environment, status, evidence
6. **Coverage Matrix** — domain, applicable, evidence, gaps
7. **Findings Summary table** — ID, severity, priority, confidence, status, component, title
8. **Finding Details** — per finding: ID, fingerprint, source, asset, trust boundary, evidence, reproduction, prerequisites, reachability, impact, severity, priority, confidence, root cause, remediation, verification plan, status
9. **Duplicates and Correlations**
10. **Remediation Status table** — finding, owner, status, fix revision, retest, result
11. **Accepted Risks table** — finding, approver, compensating control, expiry, residual risk
12. **Stale or Missing Evidence**
13. **External Assessment** — requirement, status, assessor, authorized scope, report, retest
14. **Release Recommendation** — status, blocking findings, required actions, monitoring/rollback requirements
15. **Sensitive Information Handling**
16. **Final Statement** — one of the five verdicts

## 33. Compact Protocol

```
IDENTIFY REVISION, ARTIFACT, AND ENVIRONMENT
  → DEFINE SCOPE AND AUTHORIZATION
  → BUILD MINIMUM THREAT MODEL
  → CLASSIFY CHANGE RISK
  → SELECT REQUIRED REVIEW PASSES
  → VERIFY TOOL SAFETY AND DATA HANDLING
  → RUN DIFF-FOCUSED REVIEW
  → RUN APPLICABLE STATIC, SUPPLY-CHAIN, CONFIG, AND INFRASTRUCTURE CHECKS
  → RUN AUTHORIZED DYNAMIC OR ADVERSARIAL VALIDATION
  → NORMALIZE AND DEDUPLICATE FINDINGS
  → TRIAGE SEVERITY, PRIORITY, CONFIDENCE, AND REACHABILITY
  → CREATE REMEDIATION SPECIFICATIONS
  → TRACK FIXES AND SECURITY TESTS
  → RETEST ORIGINAL AND RELATED ATTACK PATHS
  → INVALIDATE STALE EVIDENCE
  → RECORD ACCEPTED RISKS
  → ISSUE RELEASE VERDICT
```

## 34. Zoo-Code Profile

Project-specific commands for this repository's security review workflow are recorded as a subsection here when defined. They are supplementary to the generic logic above and never override it.

_(To be populated with repository-specific commands when the repo defines a security workflow. Until then, use the generic procedures in sections 9–33.)_

## 35. Hard Rules

- Never skip Pass 0 (scope and threat modeling).
- Never run unauthorized production testing, active exploitation, or social engineering.
- Default review environment is isolated test/staging.
- Do not force an external pen test for every release — base it on risk and policy.
- Do not treat tool output as fact — perform false-positive triage.
- Separate severity from remediation priority.
- Handle Critical/High strictly, but with a clear risk acceptance process.
- Link every finding to a specific revision, artifact, and environment.
- Mark previous results stale after source or config changes.
- Do not expose secrets or sensitive data in reports.
- The AI does not replace external pen testers and does not claim to.
- Prefer actionable procedures over declarative checklists.

## 36. Definitions

- **Finding**: a normalized, evidence-linked observation of a potential security issue.
- **Security invariant**: a property that must always hold (e.g., tenant isolation).
- **Trust boundary**: a point where trust level changes.
- **Reachability**: whether an attack path from an entry point to the vulnerable code exists.
- **Stale evidence**: results no longer valid because the reviewed state changed.
- **Compensating control**: a control that reduces risk without fixing the root cause.
