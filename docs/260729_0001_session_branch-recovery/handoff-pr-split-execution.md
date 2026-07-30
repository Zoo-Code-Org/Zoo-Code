# 핸즈오프 문서: 27개 PR 분리 실행 계획

## 작성일: 2026-07-29

## 작성자: VP (Orchestrator + Crow)

## 세션: 260729_0001_session_branch-recovery

---

## 1. 목표

6개 feature 브랜치의 변경사항을 27개의 상호 배타적(mutually exclusive) PR로 분리하여, Zoo Code code owner가 안전하게 리뷰할 수 있도록 한다.

### 최종 목표

1. fork(myk1yt)에 27개 PR을 올려 CI 테스트 통과 확인
2. CI 통과 후 upstream에 올려 code owner 리뷰 요청

### 선택된 방식

**방식 A: Clean main 재구성** — main에서 깨끗하게 시작하여 27개 PR을 각각 독립적으로 구현

---

## 2. 원본 feature 브랜치 매핑

각 PR은 다음 6개 feature 브랜치 중 하나에 속한다:

| 기능 ID | 브랜치명                                  | 설명                               | PR 범위               |
| ------- | ----------------------------------------- | ---------------------------------- | --------------------- |
| SHELL   | `feature/unified-shell-resolution`        | 통합 셸 해석 시스템                | SHELL-01 ~ SHELL-06   |
| ERROR   | `feat/error-interception-middleware`      | 에러 가로채기 미들웨어             | ERROR-01 ~ ERROR-02   |
| MIMO    | `fix/mimo-parallel-tool-call-policy`      | MiMo tool call 정책                | MIMO-01 ~ MIMO-03     |
| STRICT  | `feat/openai-compatible-strict-reasoning` | OpenAI Compatible strict/reasoning | STRICT-01 ~ STRICT-02 |
| STATS   | `feature/local-usage-stats`               | 로컬 사용량 통계 대시보드          | STATS-01 ~ STATS-08   |
| DND     | `feature/task-dnd-ux`                     | 작업 드래그앤드롭 폴더 관리        | DND-01 ~ DND-06       |

---

## 3. 27개 PR 상세 정의

### SHELL: 통합 셸 해석 시스템 (6개 PR)

#### SHELL-01: 셸 계약, 설정 스키마, 순수 분류

- **소속**: `feature/unified-shell-resolution`
- **파일**: `packages/types/src/global-settings.ts`, `packages/types/src/terminal.ts`, `packages/types/src/__tests__/terminal-shell-settings.spec.ts`, `src/integrations/terminal/shell/types.ts`, `src/integrations/terminal/types.ts`, `src/utils/shell.ts`, `src/utils/__tests__/shell.spec.ts`
- **예상 변경**: ~1,000줄
- **난이도**: High
- **선행**: clean main
- **검증**: `pnpm --filter @roo-code/types test -- terminal-shell-settings.spec.ts`; `cd src; npx vitest run utils/__tests__/shell.spec.ts`

#### SHELL-02: 프로파일/셸 해석 알고리즘

- **소속**: `feature/unified-shell-resolution`
- **파일**: `TerminalProfileResolver.ts`, `ShellResolver.ts`, `TerminalProfile.spec.ts`, `ShellResolver.spec.ts`
- **예상 변경**: ~1,970줄
- **난이도**: XL
- **선행**: SHELL-01

#### SHELL-03: 호출/명령환경 계획

- **소속**: `feature/unified-shell-resolution`
- **파일**: `ShellInvocationAdapter.ts`, `CommandEnvironmentService.ts`, `ShellInvocationAdapter.spec.ts`
- **예상 변경**: ~655줄
- **난이도**: Medium-High
- **선행**: SHELL-02

#### SHELL-04: 터미널 스케줄러/생명주기

- **소속**: `feature/unified-shell-resolution`
- **파일**: `CommandScheduler.ts`, `CommandTrace.ts`, `TerminalLifecycle.ts`, 테스트 2개
- **예상 변경**: ~3,095줄
- **난이도**: XL
- **선행**: SHELL-03

#### SHELL-05: 터미널 레지스트리/프로세스 어댑터

- **소속**: `feature/unified-shell-resolution`
- **파일**: `BaseTerminal.ts`, `Terminal.ts`, `TerminalProcess.ts`, `TerminalRegistry.ts`, `ExecaTerminal.ts`, `ExecaTerminalProcess.ts`, 테스트 6개
- **예상 변경**: ~2,650줄
- **난이도**: XL
- **선행**: SHELL-04

#### SHELL-06: execute-command/프롬프트 통합

- **소속**: `feature/unified-shell-resolution`
- **파일**: `build-tools.ts`, `ExecuteCommandTool.ts`, `system.ts`, `rules.ts`, `system-info.ts`, `execute_command.ts`, `index.ts`, `generateSystemPrompt.ts`, `extension.ts`, 테스트/스냅샷
- **예상 변경**: ~2,050줄
- **난이도**: XL
- **선행**: SHELL-05

---

### ERROR: 에러 가로채기 미들웨어 (2개 PR)

#### ERROR-01: 에러 분류 패턴/상태/변환

- **소속**: `feat/error-interception-middleware`
- **파일**: `src/core/tools/error-interception/` 내 모든 프로덕션 파일 (테스트 제외)
- **예상 변경**: ~2,820줄
- **난이도**: XL
- **선행**: clean main

#### ERROR-02: 인터셉터 단위 테스트

- **소속**: `feat/error-interception-middleware`
- **파일**: `src/core/tools/error-interception/__tests__/` 내 5개 파일
- **예상 변경**: ~3,430줄
- **난이도**: XL
- **선행**: ERROR-01

---

### MIMO: MiMo tool call 정책 (3개 PR)

#### MIMO-01: 모델 capability/제어/API 정책

- **소속**: `fix/mimo-parallel-tool-call-policy`
- **파일**: `model.ts`, `mimo.ts`(types), `api/index.ts`, `mimo.ts`(api), `mimo.spec.ts`, `tool-call-policy.spec.ts`
- **예상 변경**: ~850줄
- **난이도**: High
- **선행**: ERROR-01

#### MIMO-02: 파서/보유정책/Task 통합 (수렴 PR)

- **소속**: `fix/mimo-parallel-tool-call-policy`
- **핵심**: 이 PR은 ERROR와 MIMO의 수렴 지점. `NativeToolCallParser.ts`, `presentAssistantMessage.ts`를 여기서만 수정
- **파일**: `NativeToolCallParser.ts`, `presentAssistantMessage.ts`, `ToolCallRetentionPolicy.ts`, 관련 테스트 8개, `tools.ts`, e2e fixture
- **예상 변경**: ~5,000줄
- **난이도**: XL (가장 리스크 높은 수렴 PR)
- **선행**: ERROR-02, MIMO-01

#### MIMO-03: 정책 텔레메트리

- **소속**: `fix/mimo-parallel-tool-call-policy`
- **파일**: `telemetry.ts`(types), `TelemetryService.ts`, `ToolCallRetentionPolicy-telemetry.spec.ts`
- **예상 변경**: ~370줄
- **난이도**: Medium
- **선행**: MIMO-02

---

### STRICT: OpenAI Compatible strict/reasoning (2개 PR)

#### STRICT-01: strict schema/reasoning 백엔드

- **소속**: `feat/openai-compatible-strict-reasoning`
- **파일**: `provider-settings.ts`, `provider-settings.test.ts`, `base-provider.ts`, `base-openai-compatible-provider.ts`, `base-provider.spec.ts`
- **예상 변경**: ~390줄
- **난이도**: Medium
- **선행**: MIMO-01

#### STRICT-02: OpenAI 설정 UI/번역 (수렴 PR)

- **소속**: `feat/openai-compatible-strict-reasoning`
- **핵심**: 이 PR은 SHELL과 STRICT의 수렴 지점. `SettingsView.tsx`를 여기서만 수정
- **파일**: `OpenAICompatible.tsx`, `ThinkingBudget.tsx`, `ThinkingBudget.spec.tsx`, `SettingsView.tsx`, `ALL_SETTINGS_LOCALES`
- **예상 변경**: ~700줄
- **난이도**: High
- **선행**: STRICT-01, SHELL-01

---

### STATS: 로컬 사용량 통계 (8개 PR)

#### STATS-01: 사용량 이벤트/쿼리 계약

- **소속**: `feature/local-usage-stats`
- **파일**: `usage-stats.ts`, `usage-stats.spec.ts`
- **예상 변경**: ~512줄
- **난이도**: Medium-High
- **선행**: clean main

#### STATS-02: append-only 이벤트 스토어

- **소속**: `feature/local-usage-stats`
- **파일**: `UsageEventStore.ts`, `UsageStatsService.ts`, `index.ts`, 테스트 2개
- **예상 변경**: ~2,805줄
- **난이도**: XL
- **선행**: STATS-01

#### STATS-03: 집계/비용 재계산

- **소속**: `feature/local-usage-stats`
- **파일**: `UsageAggregator.ts`, `costRecalculation.ts`, 테스트 2개
- **예상 변경**: ~2,180줄
- **난이도**: XL
- **선행**: STATS-02

#### STATS-04: Task 계기화/사용량 기록 (수렴 PR)

- **소속**: `feature/local-usage-stats`
- **핵심**: 이 PR은 SHELL, MIMO, STATS의 수렴 지점. `Task.ts`를 여기서만 수정
- **파일**: `UsageRecorder.ts`, `Task.ts`, `Task.usage-stats.spec.ts`
- **예상 변경**: ~920줄
- **난이도**: XL
- **선행**: SHELL-06, MIMO-03, STATS-03

#### STATS-05: 프로바이더 사용량 정규화 (수렴 PR)

- **소속**: `feature/local-usage-stats`
- **핵심**: 이 PR은 STRICT과 STATS의 수렴 지점. `openai.ts`를 여기서만 수정
- **파일**: `anthropic-vertex.ts`, `kenari.ts`, `mistral.ts`, `moonshot.ts`, `openai.ts`, `openai-codex.ts`, 관련 테스트, `qwen-code.ts`
- **예상 변경**: ~700줄
- **난이도**: High
- **선행**: STRICT-01, STATS-01

#### STATS-06: 호스트 쿼리/내보내기/세션

- **소속**: `feature/local-usage-stats`
- **파일**: `usageStatsMessageHandler.ts`, `usageStatsMessageHandler.spec.ts`
- **예상 변경**: ~2,140줄
- **난이도**: XL
- **선행**: STATS-03, STATS-05

#### STATS-07: 대시보드 UI/히트맵/포매터

- **소속**: `feature/local-usage-stats`
- **파일**: `App.tsx`, `dashboard/` 전체, `stats/` 전체, `formatNumber.ts`, 테스트
- **예상 변경**: ~4,170줄
- **난이도**: XL
- **선행**: STATS-06

#### STATS-08: 대시보드/명령 현지화

- **소속**: `feature/local-usage-stats`
- **파일**: `ALL_DASHBOARD_LOCALES`, `ALL_STATS_LOCALES`, `ALL_PACKAGE_NLS`, `registerCommands.ts`, `built-in-commands.spec.ts`
- **예상 변경**: ~3,190줄
- **난이도**: Medium
- **선행**: STATS-07

---

### DND: 작업 DnD 폴더 관리 (6개 PR)

#### DND-01: 작업조직 계약/DnD 의존성 (수렴 PR)

- **소속**: `feature/local-usage-stats`(계약) + `feature/task-dnd-ux`(의존성)
- **핵심**: 이 PR은 모든 타입 내보내기의 수렴 지점. `index.ts`, `vscode-extension-host.ts`를 여기서만 수정
- **파일**: `task-organization.ts`, `index.ts`, `vscode-extension-host.ts`, `vscode.ts`, `package.json`, `pnpm-lock.yaml`, 테스트
- **예상 변경**: ~530줄
- **난이도**: High
- **선행**: STATS-01

#### DND-02: 호스트 메시지/ClineProvider 수렴 (수렴 PR)

- **소속**: `feature/task-dnd-ux`
- **핵심**: 이 PR은 SHELL, STATS, DND의 수렴 지점. `ClineProvider.ts`, `webviewMessageHandler.ts`를 여기서만 수정
- **파일**: `TaskOrganizationStore.ts`, `taskOrganizationMessageHandler.ts`, `ClineProvider.ts`, `webviewMessageHandler.ts`, `safeWriteJson.ts`, 테스트
- **예상 변경**: ~1,400줄
- **난이도**: XL
- **선행**: SHELL-06, STATS-06, DND-01

#### DND-03: DnD 상태 모델

- **소속**: `feature/task-dnd-ux`
- **파일**: `taskOrganizationModel.ts`, `taskOrganizationModel.spec.ts`
- **예상 변경**: ~1,280줄
- **난이도**: XL
- **선행**: DND-02

#### DND-04: DnD 컴포넌트

- **소속**: `feature/task-dnd-ux`
- **파일**: `ManualFolderItem.tsx`, `DraggableTaskEntry.tsx`, `PinButton.tsx`, `PinnedHistoryItem.tsx`, `DeleteFoldersDialog.tsx`, `FolderNameDialog.tsx`, `TaskOrganizationDndSurface.tsx`, `TaskOrganizationErrorBoundary.tsx`, `TaskOrganizationInteractionContext.tsx`, `TaskOrganizationPointerSensor.tsx`, 테스트
- **예상 변경**: ~2,450줄
- **난이도**: XL
- **선행**: DND-03

#### DND-05: HistoryView 통합

- **소속**: `feature/task-dnd-ux`
- **파일**: `HistoryView.tsx`, `useTaskOrganizationDnd.ts`, `ExtensionStateContext.tsx`, 테스트
- **예상 변경**: ~1,820줄
- **난이도**: XL
- **선행**: DND-04

#### DND-06: 현지화/채팅 정리

- **소속**: `feature/task-dnd-ux`
- **파일**: `ALL_HISTORY_LOCALES`, `ALL_CHAT_LOCALES`
- **예상 변경**: ~1,260줄
- **난이도**: Medium
- **선행**: DND-05

---

## 4. 의존성 그래프 및 제출 순서

```
Stage 1:  SHELL-01
          ↓
Stage 2:  SHELL-02 ← ERROR-01 ← STATS-01
          ↓
Stage 3:  SHELL-03
          ↓
Stage 4:  SHELL-04 ← MIMO-01 ← STRICT-01
          ↓
Stage 5:  SHELL-05
          ↓
Stage 6:  SHELL-06 ← ERROR-02 ← STATS-02 ← DND-01
          ↓
Stage 7:  MIMO-02 ← STATS-03
          ↓
Stage 8:  MIMO-03 ← STRICT-02 ← STATS-05
          ↓
Stage 9:  STATS-04 ← STATS-06 ← DND-02
          ↓
Stage 10: STATS-07 ← DND-03
          ↓
Stage 11: STATS-08 ← DND-04
          ↓
Stage 12: DND-05
          ↓
Stage 13: DND-06
```

---

## 5. 공유 파일 소유권 규칙

| 공유 파일                                                                | 소유 PR   | 통합 기능                                 |
| ------------------------------------------------------------------------ | --------- | ----------------------------------------- |
| `src/core/task/Task.ts`                                                  | STATS-04  | 셸 환경 + MiMo 정책 + 사용량 기록         |
| `src/core/webview/ClineProvider.ts`                                      | DND-02    | 셸 서비스 + 통계 서비스 + 작업조직 스토어 |
| `src/core/webview/webviewMessageHandler.ts`                              | DND-02    | 셸 + 통계 + 작업조직 메시지 라우트        |
| `NativeToolCallParser.ts` + `presentAssistantMessage.ts`                 | MIMO-02   | 에러차단 + 보유정책                       |
| `openai.ts` + 테스트                                                     | STATS-05  | strict schema + 사용량 계산               |
| `packages/types/src/index.ts` + `vscode-extension-host.ts` + `vscode.ts` | DND-01    | 모든 내보내기                             |
| `SettingsView.tsx`                                                       | STRICT-02 | 셸 설정 + strict reasoning 설정           |
| 모든 `chat.json` 로케일                                                  | DND-06    | strict 채팅 키 정리 + 작업조직 채팅 정리  |

---

## 6. 실행 계획

### Phase 1: Fork 준비

1. fork(myk1yt)의 PR 비움 확인 ✅
2. clean main 브랜치 준비

### Phase 2: 27개 PR 브랜치 생성 (방식 A)

각 PR을 clean main에서 독립적으로 구현:

1. `git checkout -b pr/<PR-ID> main`
2. 해당 PR의 파일만 변경
3. 빌드/테스트 검증
4. fork에 push
5. PR 생성 (base: main 또는 선행 PR의 브랜치)

### Phase 3: CI 검증

1. 각 PR의 CI 통과 확인
2. 실패 시 수정 후 force-push
3. 모든 PR 통과 확인

### Phase 4: Upstream 올리기

1. 사용자 결심 후 upstream에 push
2. PR 생성 및 code owner 리뷰 요청

---

## 7. PR 명명 규칙

### 브랜치 이름

```
pr/<기능ID>-<번호>-<slug>
```

예시:

- `pr/shell-01-contracts`
- `pr/error-01-taxonomy`
- `pr/mimo-02-parser-policy`
- `pr/stats-07-dashboard-ui`
- `pr/dnd-02-host-convergence`

### PR 제목

```
[기능ID] 번호: 설명
```

예시:

- `[SHELL] 01: Shell contracts, settings schema, and pure classification`
- `[ERROR] 01: Error taxonomy, patterns, validation, state, and transformation`
- `[MIMO] 02: Parser, retention policy, task-result integration (convergence)`
- `[STATS] 07: Dashboard UI, heatmap, sessions, and formatters`
- `[DND] 02: Host message handler and ClineProvider convergence`

### PR 본문 템플릿

```markdown
## Feature: [기능명] ([브랜치명])

## PR: [번호] of [총 수] in [기능ID] series

### What this PR implements

[구현 내용]

### Why this PR exists

[존재 이유]

### Dependency

- Depends on: [선행 PR]
- Feature branch: [브랜치명]

### Verification

[검증 명령어]

### Convergence note (해당 시)

This PR is a convergence point for [기능1], [기능2], [기능3].
Shared files modified: [파일 목록]
```

---

## 8. 리스크 및 완화 전략

| 리스크              | 영향 | 완화                                              |
| ------------------- | ---- | ------------------------------------------------- |
| 수렴 PR 충돌        | 높음 | 파일 소유권 규칙严格执行, 선행 PR merge 후 재검증 |
| 대형 파일 리뷰 거부 | 중간 | 심볼 수준 리뷰 가이드 첨부, 테스트와 구현 분리    |
| CI 실패 연쇄        | 중간 | 독립적 검증 명령어 제공, 빠른 수정 반복           |
| lock 파일 충돌      | 낮음 | DND-01에서만 변경, 다른 PR은 동일 lock 사용       |
| upstream 리뷰 지연  | 낮음 | fork에서 충분히 검증 후 올림                      |

---

## 9. 결정 기록

### [2026-07-29 22:05]

- "방식A를 택하도록 해야지" → Clean main 재구성 방식 확정

### [2026-07-29 21:52]

- "아직 push하지 말고, 로컬에서 리베이스 스택 체인부터 만들자" → 로컬 리베이스 완료

### [2026-07-29 21:44]

- "상호 배타적인(mutually exclusive) 개별 PR로 쪼개야해. 20개 이상" → 27개 PR 분석 완료

### [2026-07-29 21:27]

- "6개 feature 브랜치 각각을 정리(clean)해서 PR-ready 상태로 만든다" → PR-ready 정리 완료

### [2026-07-29 18:26]

- "브랜치마다 포함된 TEST파일이나 쓸모없는 파일들을 제거해야하는거 아냐?" → PR 정리 기준 확립

---

## 10. 다음 세션에서 해야 할 일

1. **이 핸즈오프 문서를 읽고** 전체 계획 이해
2. **clean main 브랜치 준비** (upstream main에서 시작)
3. **SHELL-01부터 시작**하여 27개 PR을 순서대로 구현
4. **각 PR마다**: 브랜치 생성 → 파일 변경 → 빌드 검증 → fork push → PR 생성
5. **CI 통과 확인** 후 upstream 올리기 결정

---

## 11. 참고 자료

### 전략 분석 보고서

- [`docs/260729_0001_session_branch-recovery/pr-split-strategy.md`](pr-split-strategy.md) — 27개 PR 상세 분석 (725줄)

### 복구 작업 보고서

- [`docs/260729_0001_session_branch-recovery/165500_code-verification-report.md`](165500_code-verification-report.md) — 파일 복구 검증
- [`docs/260729_0001_session_branch-recovery/190300_code-report.md`](190300_code-report.md) — PR-ready 정리
- [`docs/260729_0001_session_branch-recovery/210100_code-rebase-chain-report.md`](210100_code-rebase-chain-report.md) — 리베이스 스택 체인

### Git 상태

- 워킹 브랜치: `pr/b01-error-contracts` (176 커밋 ahead of main, 로컬 복구용)
- 6개 feature 브랜치: 순차 리베이스 완료 (clean, PR-ready)
- fork PR: 비워짐 (27개 새 PR 대기)
