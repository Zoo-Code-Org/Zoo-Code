# Context Save

## Date: 2026-07-30 23:33 KST

## Session: Dashboard Crash/Slowness Fix + Multi-Branch Testing

### Git State

- Branch: feature/local-usage-stats
- Recent commits:
    - 0769ccea7 fix(stats): use daily rollups for date-bounded breakdown queries instead of monthly
    - dcff7b656 fix(stats): DST-correct startOfDay by evaluating offset at target midnight (R4)
    - d8130fd6d fix(stats): heatmap values now use tokens instead of cost (R3) and UI presets stop sending redundant from/to (R5)
    - 8550b1ba0 perf(stats): serve dashboard snapshots from rollup tables instead of full event scan (R1)
    - 7f1e363e9 fix(stats): store day buckets in local timezone and add v2 migration
- Working tree: 1 untracked file (ask-full-audit-report.md)

### Task Progress — feature/local-usage-stats (COMPLETED)

- [x] Phase 1: Brainstorm - 5W1H 분석
- [x] Phase 2: Debug 조사 - 5개 Root Cause 발견 (R1-R5)
- [x] Phase 3: Architecture - 수정 계획 수립 (5개 sub-task)
- [x] Phase 3.5: Subdivision - 4개 배치 분할
- [x] Phase 4: Implementation - 4개 배치 + audit 피드백 수정
- [x] Phase 5: Technical Review - 415+ tests pass
- [x] Phase 6: Final Ask Audit - CONDITIONAL APPROVAL → 수정 후 PASS

### Remaining Tasks (NEW — User Request)

User requested: "나머지 브랜치들도 하나씩 해당 브랜치로 전환해 가면서 버그가 있는지 없는지 전부 테스트하고, 수정해줘. 모든 브랜치가 전부 수정이 완료되면, 다음의 브랜치들이 모두 포함된 브랜치로 전환해서 vsix를 만들어서 설치해줘."

Branches to test:

1. [ ] feature/unified-shell-resolution
2. [ ] feat/error-interception-middleware
3. [ ] fix/mimo-parallel-tool-call-policy
4. [x] feature/local-usage-stats (DONE)
5. [ ] feature/task-dnd-ux
6. [ ] feat/openai-compatible-strict-reasoning

Integration branch: TBD (need to find branch containing all 6)
VSIX build and install: TBD

### Decisions Made

- R1: Option A (rollup-backed reads) — eliminates O(N) main-thread scan
- R2: Option A (local timezone day bucket + migration)
- R3: tokens (not cost) for heatmap values
- R4: DST-correct offset evaluation at target midnight
- R5: Backend is authoritative; UI sends preset-only for named presets
- R3.5 (audit): daily rollups instead of monthly for date-bounded breakdowns

### Open Questions

- Which integration branch contains all 6 feature branches?
- Do the other 5 branches have bugs that need fixing?
- Model had persistent parallel tool call corruption (PARAM_TYPE_MISMATCH) — may need fresh session

### Session Folder

docs/260730_0002_session_dashboard-crash-debug/
