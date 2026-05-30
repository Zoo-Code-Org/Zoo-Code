## Poo Code

Poo-Code is a fork of Zoo-Code which is a fork of Roo-Code which is a fork of Cline. I named it "Poo" because I don't know if it will work or not. In other words, it can either be total sh\*t or become organic fertilizer that will take legacy "spaghetti code" and "crap architectures," breaks them down, and uses full AI automation to fertilize it into beautifully optimized, blooming software to flush out bad code so your codebase can grow.
(The truth is I am too lazy to chunk it into smaller commits — see PR [#252](https://github.com/Zoo-Code-Org/Zoo-Code/pull/252) for the full pile)

> **⚠ EXPERIMENTAL** — This fork adds a full self-improving AI layer on top of Zoo-Code. All new features are gated behind experiment toggles. Enable at your own risk. PR [#252](https://github.com/Zoo-Code-Org/Zoo-Code/pull/252) contains the complete diff.

---

## The Problem

1. I can't sleep well because of anxiety due to the wrong decisions it made by always selecting the first choice as the answer.
2. It ruined my morning because when I woke up I found it having an unauthorized day off during a busy day (silently stuck because of an error).

The ultimate goal is to totally replace you, so you can be permanently "Ooo" (Out of Office) and jobless like I am.

## What's different from Zoo-Code

This fork adds **~10,500 lines** of self-improving infrastructure across **45 files** (25 source + 20 test), all behind experiment toggles. Every new feature is gated — Zoo-Code main's behaviour is preserved with everything off.

| Feature                    | Poo-Code (this branch)                                                                                                                                                            | Zoo-Code main                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Self-improving loop**    | `SelfImprovingManager` — background review pass every N turns/tool calls. Learns from mistakes, curates skills, suggests optimizations.                                           | ❌ No automated self-review    |
| **Pattern analysis**       | `PatternAnalyzer` — detects recurring tool-use patterns, error signatures, and skill gaps from execution history.                                                                 | ❌ No pattern detection        |
| **Curator service**        | `CuratorService` — tar.gz-backed skill store (backup/rollback). Decides when to create/update/merge skills from learned patterns.                                                 | ❌ Manual skill authoring only |
| **Skill automation**       | `ActionExecutor` + `ImprovementApplier` — auto-creates and updates skills from reviewed patterns.                                                                                 | ❌ No auto skill creation      |
| **Insights engine**        | `InsightsEngine` — generates project-level insights (dead code, stale configs, architecture notes).                                                                               | ❌ No project insights         |
| **Resilience**             | `ResilienceService` — streaming backoff, tool error healer, auto-retry with learned recovery strategies.                                                                          | ❌ Basic retry only            |
| **Question evaluation**    | `QuestionEvaluatorService` — evaluates user questions for clarity/completeness; auto-selects best answer when choices are offered.                                                | ❌ Always picks first choice   |
| **Trust service**          | `TrustService` — learns tool-approval patterns over time. Full-trust mode auto-approves known-safe tools.                                                                         | ❌ Static auto-approval rules  |
| **Review team**            | `ReviewTeamService` — multi-agent review (innovator + critic + decider) scores every learned pattern before applying it.                                                          | ❌ No pre-apply validation     |
| **Agent memory**           | `AgentMemoryAdapter` + `MemoryStore` + `MemoryBackendFactory` — pluggable memory backend (SQLite default, configurable). Bounded context injection via `memory.ts` types.         | ❌ No persistent agent memory  |
| **Learning store**         | `LearningStore` — stores/retrieves learned patterns with confidence scoring. Schema-versioned for forward compat.                                                                 | ❌ No learning storage         |
| **Transcript recall**      | `TranscriptRecall` — retrieves past conversation context for pattern learning.                                                                                                    | ❌ No historical context       |
| **Skill usage tracking**   | `SkillUsageStore` — tracks which skills fire, success rate, frequency. Feeds curator decisions.                                                                                   | ❌ No usage metrics            |
| **Auto-mode orchestrator** | `AutoModeOrchestrator` — automatically switches between VS Code modes based on task type.                                                                                         | ❌ Manual mode switching       |
| **Mode factory**           | `ModeFactoryService` — generates custom modes from learned workflows.                                                                                                             | ❌ Fixed mode set              |
| **Experiment toggles**     | 6 new experiment IDs: `selfImproving`, `selfImprovingAutoSkills`, `selfImprovingAutoMode`, `selfImprovingReviewTeam`, `selfImprovingFullTrust`, `selfImprovingQuestionEvaluation` | ❌ None of these exist     |
| **ONE-SHOT Orchestrator**  | Autonomous 8-phase sequential build agent — handles entire projects from requirements to verification in a single pass                                                              | ❌ No equivalent            |
| **KAIZEN Orchestrator**    | Continuous improvement agent with 7-step iteration loop (Analyze → Identify → Fix → Verify → Enhance → Git Push → Re-evaluate) and self-evolving mini-goals                        | ❌ No equivalent            |
| **Proactive Error Prevention** | Pre-execution tool call validation, structured error classification (12 categories), cascading failure detection, and prevention hint injection — catches errors BEFORE they happen | ❌ No equivalent            |
| **Git Auto-Push**          | KAIZEN mode auto-commits and pushes every cycle, enabling CI/CD pipelines to apply changes to staging/production automatically                                                     | ❌ No equivalent            |
| **Self-Evolving Mini-Goals** | Mini-goals automatically evolve upward as each is achieved, with healing that reverts to fixing regressions first                                                                  | ❌ No equivalent            |
| **Full UI Coverage**       | All 27 self-improving services now have toggles, config panels, or status displays in the settings UI                                                                              | ❌ No equivalent            |

### Experiment gate reference

| Toggle                            | Enables                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `selfImproving`                   | Master switch — enables the entire learning loop             |
| `selfImprovingAutoSkills`         | Auto-create/update/merge skills from learned patterns        |
| `selfImprovingAutoMode`           | Auto-switch VS Code modes based on task                      |
| `selfImprovingReviewTeam`         | Multi-agent review before applying learned patterns          |
| `selfImprovingFullTrust`          | Auto-approve tools that TrustService considers safe          |
| `selfImprovingQuestionEvaluation` | Evaluate user questions for clarity; auto-select best answer |
| `oneShotOrchestrator`             | Enable ONE-SHOT Orchestrator mode for autonomous project builds |
| `kaizenOrchestrator`              | Enable KAIZEN Orchestrator mode for continuous improvement |
| `proactiveErrorPrevention`        | Enable pre-execution tool call validation and cascade detection |
| `gitAutoPush`                     | Enable auto-commit and push in KAIZEN mode |
| `selfEvolvingMiniGoals`           | Enable self-evolving mini-goals with regression healing |
| `fullUICoverage`                  | Enable full UI coverage for all self-improving services |

## Use Case Examples

### Example 1: One-Shot Project Build

**Scenario:** You need to build a complete REST API server from scratch.

1. Switch to **ONE-SHOT Orchestrator** mode
2. Describe your requirements: "Build a FastAPI REST API with PostgreSQL backend, JWT auth, and CRUD endpoints for users and products"
3. The agent autonomously executes 8 phases:
   - Requirements analysis → Architecture design → Project scaffolding → Core implementation → Integration → Testing → Bug fixing → Verification
4. Result: A fully tested, production-ready API server with zero manual intervention

### Example 2: Continuous Codebase Improvement

**Scenario:** You have an existing codebase with technical debt and want continuous improvement.

1. Switch to **KAIZEN Orchestrator** mode
2. Set your initial mini-goal: "Fix all TypeScript strict mode errors"
3. The agent enters the Kaizen loop:
   - **Cycle 1**: Analyzes errors → Fixes 3 type errors → Runs tests → Git push → Re-evaluates
   - **Cycle 2**: Fixes 5 more errors → Runs tests → Git push → Evolves mini-goal
   - **Cycle N**: Continues until mini-goal achieved, then evolves upward
4. Each cycle is one atomic change, verified, and pushed to CI/CD
5. Result: Continuous, safe improvement without regressions

### Example 3: Proactive Error Prevention

**Scenario:** You're working on a large codebase and the model keeps hitting tool errors.

1. Enable **Prevention Engine** and **Cascade Tracker** in Experimental Settings
2. Before each tool call, the system validates parameters:
   - `read_file` with directory path → warns to use `list_files` instead
   - `list_files recursive=true` without ripgrep → suggests `find`/`ls` fallback
   - Long `execute_command` → warns about shell limits
3. After errors, the system classifies them and tracks cascading failures
4. If 2+ errors occur within 30 seconds, a cascade warning is injected suggesting an approach change
5. Result: Fewer wasted tool calls, faster task completion, lower API costs

### Example 4: Self-Healing Production Deployment

**Scenario:** A production deployment has regressions and needs immediate attention.

1. Switch to **KAIZEN Orchestrator** mode
2. The agent analyzes logs and test results
3. Detects regressions → mini-goal auto-reverts to fixing those first
4. Each fix is verified, committed with `kaizen: fix regression in X`, and pushed
5. CI/CD pipeline auto-deploys each fix to staging/production
6. Once regressions are resolved, mini-goal evolves upward to the next improvement
7. Result: Self-healing deployment with zero manual intervention

## Statistic

Projects generated: Countless

Monthly cost: LLM & electric bills

Non-refundable cost: My soul

Revenue generated so far: 0 and still counting zero

## Special Messages

Don't star this repo. It will just get me excited to drag you into the jobless community

Any issue not related to self-learning, submit at https://github.com/Zoo-Code-Org/Zoo-Code/issues as they know more than me (no cap)

## FAQ

**Q:** What is your day job?

**A:** Jobless

**Q:** What is your night job?

**A:** Sleep

**Q:** Ooo... Can I buy you coffee?

**A:** No. I have insomnia.

**Q:** Can I...?

**A:** This is end of conversation.
