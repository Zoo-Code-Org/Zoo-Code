# Strategic Enhancement Plan: Reinforcing Zoo Code's Existing Code Reviewer & Security Reviewer Modes

**Date**: 2026-10-07  
**Author**: Research Specialist (Architecture & Mode Systems)  
**Status**: Completed & Ready for Review  
**Reference Inquiry**: _"리뷰어모드2개를 더 추가하는건 아닌것같고, 현행 zoo code의 코드리뷰어와 시큐리티리뷰어를 강화하는건 어때? skill은 이미 있잖아?"_

---

## 1. Executive Summary & Validation of User Intent

The user's insight is **100% accurate and architecturally sound**.

### Key Findings:

1. **The Previous Report Had a Scope Blindspot**: The earlier comparison report (`reports/reviewer-comparison-report.md`) evaluated only repository-local files (`packages/types/src/mode.ts` and the project-root `.roomodes`), concluding that Zoo Code had no reviewer modes.
2. **Reviewer Modes Already Exist in Zoo Code's Active Runtime**: In the user's actual VS Code environment, Zoo Code loads global custom modes from:  
   `%APPDATA%\Code\User\globalStorage\zoocodeorganization.zoo-code\settings\custom_modes.yaml`  
   This file **already defines**:
    - `code-reviewer` (`slug: code-reviewer`, `name: 🔎 Code Reviewer`, lines 508–546)
    - `security-reviewer` (`slug: security-reviewer`, `name: 🛡️ Security Reviewer`, lines 675–724)
    - Integrated into the `orchestrator-crow` VP workflow at Phase P5a.5.
3. **The Skills Already Exist in the User's Ecosystem**:
    - `quality-gate`: Present in `~/.roo/skills/quality-gate` and `~/.zoo/skills/quality-gate` (32.5 KB).
    - `security-review-orchestrator`: Present in `~/.roo/skills/security-review-orchestrator` and `~/.zoo/skills/security-review-orchestrator` (31.9 KB).
    - `code-review-taxonomy`: Present in Antigravity/Gemini configuration (`~/.gemini/config/skills/code-review-taxonomy` and plugin).
4. **Why Adding 2 New Modes Was the Wrong Instinct**:
    - Adding 2 new modes would create slug collisions, duplicate personas, prompt bloat, and confusion between global modes and project modes.
    - What the user is experiencing is not a lack of modes, but a **wiring gap**: the existing modes in `custom_modes.yaml` are not fully connected to the rich skills already on disk, and `code-review-taxonomy` is missing from Zoo Code's skill discovery path.

---

## 2. Current Architecture & As-Is Configuration

```mermaid
graph TD
    subgraph Active_Zoo_Code_Environment [Active Zoo Code Runtime]
        CM[custom_modes.yaml in globalStorage] --> CR[slug: code-reviewer]
        CM --> SR[slug: security-reviewer]
        CM --> VP[slug: orchestrator-crow]
    end

    subgraph Skill_Discovery [Zoo Code SkillsManager Paths]
        SK1[~/.roo/skills]
        SK2[~/.agents/skills]
        SK3[workspace/.roo/skills]
    end

    subgraph Installed_Skills [Installed Skills Inventory]
        QG[quality-gate: PRESENT in ~/.roo]
        SRO[security-review-orchestrator: PRESENT in ~/.roo]
        CRT[code-review-taxonomy: MISSING from ~/.roo, ONLY in ~/.gemini]
    end

    CR -.->|Load Attempt (FAILS)| CRT
    CR -->|Can Load| QG
    SR -.->|Prompt misses instruction to load| SRO
```

### 2.1 As-Is State: `code-reviewer` (Lines 508–546 of `custom_modes.yaml`)

- **Role**: Read-only pre-merge diff reviewer (Manager: VP `orchestrator-crow`).
- **Pipeline Structure**:
    - Stage 0: Deterministic scan via `quality-gate` skill (Phase B QG-01..14).
    - Stage 1: 8-category taxonomy scan via `code-review-taxonomy` skill.
    - Stage 2: Confidence filter ($\ge 75$; Security category bypasses to `security-reviewer`).
    - Stage 3: Learning handoff to VP.
- **Severity & Verdict**: P0~P3 scale, zero-tolerance verdict (`PASS` / `CONDITIONAL` / `REJECT`).
- **Groups**: `read`, `edit` (restricted to `^docs/`), `command`, `browser` (deprecated), `mcp`.

### 2.2 As-Is State: `security-reviewer` (Lines 675–724 of `custom_modes.yaml`)

- **Role**: Read-only security auditor.
- **Audit Dimensions**: 6 dimensions (Secrets/credentials, Auth/authz, Input validation, Data exposure, Dependency/config, Code structure monoliths >500 lines).
- **Expanded Scenarios**: 5 scenarios, including P5a.5 conditional confirmation pass paired with `code-reviewer`.
- **Severity & Verdict**: Critical / High / Medium / Low; PASS / REJECT.
- **Groups**: `read`, `edit` (restricted to `^docs/`), `command`, `browser` (deprecated), `mcp`.

---

## 3. Root Cause Analysis: The Breakage Points

Why did the existing reviewers feel underpowered or incomplete?

| Gap #     | Category                          | Problem Description                                                                                                                                                                                                                                  | Impact                                                                                                                                                                                                        |
| --------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GAP-1** | **Skill Path Disconnect**         | `code-review-taxonomy` exists in `~/.gemini/config/skills/`, but is **completely missing** from `C:\Users\k1yt\.roo\skills\` and `C:\Users\k1yt\.agents\skills\`.                                                                                    | When `code-reviewer` runs Stage 1 and executes `skill(name="code-review-taxonomy")`, Zoo Code's `SkillsManager` reports that the skill does not exist. The reviewer reverts to unguided, ad-hoc diff reading. |
| **GAP-2** | **Skill Invocation Disconnect**   | `security-review-orchestrator` (31.9 KB) is installed in `C:\Users\k1yt\.roo\skills\security-review-orchestrator\SKILL.md`, but `security-reviewer`'s custom instructions in `custom_modes.yaml` **never tell it to load the skill**!                | Instead of running a rigorous multi-pass review with threat modeling, asset boundaries, and finding normalization, `security-reviewer` only runs a superficial 6-bullet prompt check.                         |
| **GAP-3** | **Schema & Tooling Deprecations** | Both modes define `browser` in `groups`. In Zoo Code's `packages/types/src/mode.ts`, `browser` is deprecated and stripped by preprocess schemas. Neither mode has an explicit `git diff` command runbook.                                            | Minor schema noise; reviewer models sometimes ask how to get the diff instead of running standard read-only git commands.                                                                                     |
| **GAP-4** | **ZooCode Repository Specifics**  | Neither reviewer is aware of Zoo Code's unique repository invariants defined in `AGENTS.md`: <br>1. SettingsView `cachedState` pattern <br>2. `eslint-suppressions.json` non-increase invariant <br>3. Task lifecycle reducers in `taskLifecycle.ts` | Zoo Code PR reviews miss project-specific regression risks unless specifically reminded by the user.                                                                                                          |

---

## 4. Reinforcement Plan (Concrete Implementation)

Instead of creating new modes, we execute a 4-step enhancement:

### Step 1: Deploy `code-review-taxonomy` to Zoo Code's Skill Registry

Copy/symlink `code-review-taxonomy` from `~/.gemini/config/skills/code-review-taxonomy` into:

- `C:\Users\k1yt\.roo\skills\code-review-taxonomy\SKILL.md` (Global scope for all projects)
- `D:\OneDrive\Projects\ZooCode\.roo\skills\code-review-taxonomy\SKILL.md` (Project scope for ZooCode)

**Frontmatter Configuration**:

```yaml
---
name: code-review-taxonomy
description: 8-category taxonomy scan for pre-merge diff review (code-reviewer Stage 1). Classifies findings as correctness/security/stability/data-integrity/performance/maintainability/test-coverage/style-docs with P0-P3 severity and 0-100 confidence.
modeSlugs:
    - code-reviewer
    - orchestrator-crow
---
```

### Step 2: Reinforce `code-reviewer` in `custom_modes.yaml`

1. **Remove deprecated `browser`** from `groups`.
2. **Anchor Diff Acquisition Protocol**:
    - Working tree uncommitted diff: `git diff HEAD`
    - Branch pre-merge diff: `git diff origin/main...HEAD` (or target merge base)
    - Scope guard: If diff > 50 files or > 2,000 lines, request chunking.
3. **Mandatory 4-Stage Execution with Explicit Skill Loading**:
    - `Stage 0`: Load `quality-gate` skill $\rightarrow$ run non-destructive checks (`pnpm --dir src exec eslint ...`, `pnpm typecheck`). Check `eslint-suppressions.json` non-increase!
    - `Stage 1`: Load `code-review-taxonomy` skill $\rightarrow$ scan changed files across the 8 categories.
    - `Stage 2`: Filter findings (<75 confidence dropped; `security` category unconditionally forwarded to `security-reviewer`).
    - `Stage 3`: Emit standardized verdict (`PASS` / `CONDITIONAL` / `REJECT`).

### Step 3: Reinforce `security-reviewer` in `custom_modes.yaml`

1. **Remove deprecated `browser`** from `groups`.
2. **Explicit Skill Hook**:
    - Add mandatory precondition: _"Before auditing, load the `security-review-orchestrator` skill using the `skill` tool."_
3. **Upgrade Audit Dimensions with Frameworks**:
    - Anchor to OWASP Top 10, CWE Top 25, and MCP Runtime Security (audit `mcp_settings.json` and tool authorization scopes).
4. **Formalize Handoff Contract**:
    - Accept unfiltered security findings forwarded by `code-reviewer` (P5a.5 pairing).
    - Produce normalized findings: `[Dimension]`, `[CWE/OWASP]`, `[Severity: Critical/High/Med/Low]`, `[Attack Path]`, `[Remediation Spec]`.

### Step 4: Optional Project Overlay in `ZooCode/.roomodes`

If desired, mirror the enhanced `code-reviewer` and `security-reviewer` definitions into `D:\OneDrive\Projects\ZooCode\.roomodes`.

- **Advantage**: Anyone cloning or opening the ZooCode repository immediately gets the enhanced reviewers, even without the user's global `custom_modes.yaml`.
- **Precedence**: In Zoo Code, workspace `.roomodes` takes precedence over global `custom_modes.yaml`.

---

## 5. Detailed Mode Definition Diffs (Proposed Enhanced Configurations)

### 5.1 Enhanced `code-reviewer` Specification

```yaml
- slug: code-reviewer
  name: 🔎 Code Reviewer
  roleDefinition: |
      ### IDENTITY
      - Role: Pre-Merge Diff Reviewer. Manager: VP (Orchestrator+Crow).
      - Mission: Review changed-files diff BEFORE merge via a 4-stage pipeline: deterministic scan → taxonomy scan → confidence filter → learning handoff → zero-tolerance verdict. Findings feed fixes (VP → code/debug), never self-fix.
      - Authority: STRICTLY READ-ONLY. Findings and reports ONLY; NEVER modifies code, configs, or repository state.
  whenToUse: |
      Pre-merge diff review of a completed change before VP merge/commit: PR-readiness review beyond command-level quality gates — 8-category taxonomy scan with unified P0-P3 severity + confidence filter. Invoked via VP P5a.5 routing or explicit request. NOT for writing/fixing code (→ code/debug) and NOT a full security audit (→ security-reviewer).
  description: Read-only pre-merge diff reviewer with a 4-stage pipeline and zero-tolerance P0-P3 verdict.
  shortDescription: "Read-only pre-merge diff review: 4-stage pipeline, P0-P3 verdict."
  groups:
      - read
      - - edit
        - fileRegex: ^docs/
          description: Reports only
      - command
      - mcp
  source: global
  customInstructions: |
      ### DIFF ACQUISITION PROTOCOL
      0. Obtain diff via command:
         - For unstaged/staged branch changes: run `git diff HEAD`
         - For branch vs base review: run `git diff origin/main...HEAD`
         - Check status: run `git status --short`
         - Scope Guard: If diff > 50 files or > 2,000 lines, report scope overflow to VP and halt shallow pass.

      ### 4-STAGE REVIEW PIPELINE (MANDATORY IN-ORDER)
      0. Stage 0 (Deterministic Scan):
         - Load `quality-gate` skill via `skill` tool.
         - Execute project verification commands (e.g. `pnpm typecheck`, `pnpm test`).
         - Assert project invariants (e.g. `eslint-suppressions.json` suppression count must not increase).
         - Record deterministic failures; do NOT attempt fixes.

      1. Stage 1 (Semantic Taxonomy Scan):
         - Load `code-review-taxonomy` skill via `skill` tool.
         - Scan the changed-files diff across 8 categories:
           1) correctness 2) security 3) stability 4) data-integrity
           5) performance 6) maintainability 7) test-coverage 8) style-docs
         - Rate each finding with unified severity (🔴P0, 🟠P1, 🟡P2, 🟢P3) and confidence (0-100).
         - Enforce Intent Conformance: Missing or incomplete required logic is a P1 correctness defect.

      2. Stage 2 (Confidence Filter & Security Handoff):
         - Discard or downgrade findings with confidence < 75.
         - CRITICAL RULE: All `security` category findings BYPASS the confidence filter and are immediately packaged for handoff to `security-reviewer` (P5a.5 pairing).

      3. Stage 3 (Verdict & Reporting):
         - PASS: P0 = 0 and P1 = 0 (P2/P3 permitted as optional polish).
         - CONDITIONAL: P0 = 0, but open P1/P2 conditions exist with required fixes.
         - REJECT: ≥ 1 P0 finding (zero-tolerance).
         - Output report to designated folder: `docs/YYMMDD_NNNN_session_<task-slug>/code-review.md`.
         - Signal completion via `attempt_completion`.
```

### 5.2 Enhanced `security-reviewer` Specification

```yaml
- slug: security-reviewer
  name: 🛡️ Security Reviewer
  roleDefinition: |
      ### IDENTITY
      - Role: Security Auditor (Read-Only Inspector). Manager: VP (Orchestrator+Crow).
      - Mission: Systematic security audits of code, architecture, configurations, and MCP privileges — vulnerabilities, exposed secrets, and risky patterns.
      - Authority: STRICTLY READ-ONLY. Reports and remediation specifications ONLY; NEVER modifies code or configuration files.
  description: Read-only security audit agent with threat modeling, OWASP/CWE alignment, and multi-pass review orchestration.
  shortDescription: Audit code and configs for security vulnerabilities with structured remediation specs.
  whenToUse: |
      Invoke for security-sensitive domains: auth/session changes, secrets/tokens, PII/crypto, file uploads, MCP tool configs, or when code-reviewer Stage-2 hands off security findings (P5a.5).
  groups:
      - read
      - - edit
        - fileRegex: ^docs/
          description: Reports only
      - command
      - mcp
  source: global
  customInstructions: |
      ### PRECONDITION (MANDATORY SKILL HOOK)
      Before conducting audit, load `security-review-orchestrator` skill using the `skill` tool.

      ### 6 CORE AUDIT DIMENSIONS & FRAMEWORKS
      1. Secrets & Credentials (CWE-798, CWE-532): Hardcoded tokens, .env leaks, sensitive logs.
      2. Authentication & Authorization (OWASP A01/A07): Session management, RBAC/ABAC bypass, IDOR.
      3. Input Validation & Injection (OWASP A03): SQLi, Command Injection, XSS, Path Traversal, Unsafe Deserialization.
      4. Data Exposure & Crypto (OWASP A02): In-transit/at-rest encryption, weak ciphers, PII leaks.
      5. Dependencies & Misconfigurations (OWASP A05/A06): Vulnerable dependencies, overly permissive CORS/CSP.
      6. MCP & Tool Boundary Security: Parameter validation in MCP tools, privilege escalation, shell injection in command execution.

      ### 5 AUDIT SCENARIOS
      1. Standard Security Audit: Full pass on sensitive code/architecture changes.
      2. Tool Call Chain Audit: Least privilege audit for agent tool calls and integrations.
      3. Configuration File Audit: Auditing `mcp_settings.json`, `custom_modes.yaml`, environment files.
      4. Pattern Security Review: Targeted grep for regex anti-patterns (`eval`, `exec`, hardcoded paths).
      5. P5a.5 Conditional Confirmation Pass: Deep verification of raw security findings handed off by `code-reviewer`. Confirm, upgrade, or downgrade findings with concrete exploitability proofs.

      ### DELIVERABLES & SEVERITY
      - Severity: 🔴 CRITICAL · 🟠 HIGH · 🟡 MEDIUM · 🟢 LOW
      - Verdict: PASS (0 Critical, 0 High) | REJECT (≥1 Critical or High)
      - Output report to designated folder: `docs/YYMMDD_NNNN_session_<task-slug>/security-review.md`
      - Complete via `attempt_completion`.
```

---

## 6. Actionable Implementation Roadmap

| Step                                              | Target Location                              | Action Item                                                                                                                                                             | Verification                                              |
| ------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **Phase 1: Skill Sync**                           | `~/.roo/skills/code-review-taxonomy`         | Copy `code-review-taxonomy` from `~/.gemini/config/skills/` to `~/.roo/skills/`. Add `modeSlugs: ["code-reviewer", "orchestrator-crow"]`.                               | Verify Zoo Code's `SkillsManager` discovers the skill.    |
| **Phase 2: Global Mode Update**                   | `custom_modes.yaml` in VS Code globalStorage | Update `code-reviewer` and `security-reviewer` entries with reinforced prompts and clean tool groups.                                                                   | Switch to modes in Zoo Code UI; inspect prompt rendering. |
| **Phase 3: Project Local Integration (Optional)** | `D:\OneDrive\Projects\ZooCode\.roomodes`     | Add both enhanced modes to `.roomodes` with ZooCode-specific lint suppression and AGENTS.md checks.                                                                     | Check that ZooCode repository overrides load cleanly.     |
| **Phase 4: End-to-End Verification**              | ZooCode active session                       | Trigger pre-merge review on a sample diff; verify `code-reviewer` calls `quality-gate` and `code-review-taxonomy`, and hands off security items to `security-reviewer`. | 100% automated review cycle passes without error.         |

---

## 7. Conclusion

The user's proposition is completely validated. **We do not need new reviewer modes.**  
Zoo Code already has the exact mode slugs and slots designed for this purpose. By simply **synchronizing the missing skill (`code-review-taxonomy`) into Zoo Code's skill path** and **wiring the skill hooks into the existing mode definitions**, Zoo Code achieves the exact same enterprise-grade, double-blind review power without adding a single redundant mode.
