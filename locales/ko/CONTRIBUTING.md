<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

<b>한국어</b> • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Zoo Code에 기여하기

Zoo Code는 커뮤니티 프로젝트야. 모든 기여를 소중히 생각해. 우리는 [Issue-First](#issue-first-approach) 방식으로 작업해. 즉, 모든 [Pull Request(PR)](#submitting-a-pull-request)는 GitHub Issue에 연결해야 해. 이 가이드를 잘 읽어 줘.

<a id="table-of-contents"></a>

## 목차

- [기여하기 전에](#before-you-contribute)
- [기여할 내용 찾기와 계획하기](#finding--planning-your-contribution)
- [개발과 제출 과정](#development--submission-process)
    - [Pull Request에 기대하는 것](#pull-request-expectations)
    - [AI를 활용한 기여](#ai-assisted-contributions)
    - [글쓰기 방식](#writing-style)
- [법적 사항](#legal)

<a id="before-you-contribute"></a>

## 기여하기 전에

<a id="1-code-of-conduct"></a>

### 1. 행동 강령

모든 기여자는 [행동 강령](./CODE_OF_CONDUCT.md)을 따라야 해.

<a id="2-project-roadmap"></a>

### 2. 프로젝트 로드맵

로드맵은 프로젝트의 방향을 보여 줘. 다음 목표에 맞춰 기여해 줘.

<a id="reliability-first"></a>

### 신뢰성 우선

- diff 편집과 명령 실행이 매번 안정적으로 작동하게 해.
- 사람들이 Zoo Code를 매일 쓰지 못하게 하는 문제를 없애.
- 모든 로케일과 플랫폼에서 Zoo Code가 작동하게 해.
- 더 많은 AI 제공업체와 모델을 지원해.

<a id="enhanced-user-experience"></a>

### 사용자 경험 개선

- UI와 UX를 명확하고 쓰기 쉽게 만들어.
- 작업 흐름을 개선해. 개발자는 매일 쓰는 도구에 높은 품질을 기대해.

<a id="leading-on-agent-performance"></a>

### 에이전트 성능 높이기

- 실제 생산성을 측정하는 평가 벤치마크(evals)를 만들어.
- evals를 실행하기 쉽고 읽기 쉽게 만들어.
- evals 점수를 뚜렷하게 높이는 개선을 제공해.

PR에서 변경이 이 중 어떤 분야에 도움이 되는지 설명해 줘.

<a id="3-join-the-zoo-code-community"></a>

### 3. Zoo Code 커뮤니티에 참여하기

- **Discord:** [Discord](https://discord.gg/VxfP4Vx3gX)에 참여해.
- **Reddit:** [Reddit](https://www.reddit.com/r/ZooCode/)에 참여해.

<a id="finding--planning-your-contribution"></a>

## 기여할 내용 찾기와 계획하기

<a id="types-of-contributions"></a>

### 기여 유형

- **버그 수정:** 코드 문제를 고쳐.
- **새 기능:** 기능을 추가해.
- **문서:** 가이드를 개선하고 더 명확하게 만들어.

<a id="issue-first-approach"></a>

### Issue-First 방식

모든 기여는 GitHub Issue에서 시작해. 짧은 템플릿을 써 줘.

- **기존 Issue 확인하기**: [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues)를 검색해.
- **Issue 만들기**에는 다음을 써.
    - **개선:** "Enhancement Request" 템플릿(사용자에게 주는 이점을 중심으로 쉬운 말로 작성).
    - **버그:** "Bug Report" 템플릿(최소 재현 방법, 예상 결과와 실제 결과, 버전).
- **Issue 작성하기**: 아래의 [글쓰기 방식](#writing-style)을 따라 줘.
- **직접 맡고 싶어?** Issue에 "Claiming"이라고 댓글을 달아. 그다음 [Discord](https://discord.gg/VxfP4Vx3gX)에서 핵심 팀에 연락해 담당자 배정을 요청해. 핵심 팀이 해당 대화에서 배정을 확인해.
- **PR은 Issue에 연결해야 해.** 연결이 없는 PR은 닫을 수 있어.

<a id="deciding-what-to-work-on"></a>

### 작업할 내용 정하기

- [GitHub Issues 페이지](https://github.com/Zoo-Code-Org/Zoo-Code/issues)를 살펴봐.
- 문서는 [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs)를 참고해.

<a id="reporting-bugs"></a>

### 버그 신고하기

- 먼저 기존 신고를 확인해.
- ["Bug Report" 템플릿](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose)으로 새 버그를 신고하고 다음을 포함해.
    - 명확하고 번호가 붙은 재현 단계
    - 예상 결과와 실제 결과
    - Zoo Code 버전(필수)
    - 관련이 있다면 API 제공업체와 모델
- **보안 문제**: [보안 권고](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new)를 통해 비공개로 신고해.

<a id="development--submission-process"></a>

## 개발과 제출 과정

<a id="development-setup"></a>

### 개발 환경 설정

1. **포크와 복제:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **의존성 설치:**

```
pnpm install
```

3. **디버깅:** VS Code로 열어(`F5`).

<a id="writing-code-guidelines"></a>

### 코드 작성 지침

- 기능이나 수정마다 목적이 분명한 PR 하나를 만들어.
- ESLint와 TypeScript의 모범 사례를 따라.
- Issue를 참조하는 명확하고 설명이 담긴 커밋을 작성해(예: `Fixes #123`). [글쓰기 방식](#writing-style)을 따라.
- 변경을 충분히 테스트해(`npm test`).
- 제출 전에 최신 `main` 브랜치로 리베이스해.

<a id="submitting-a-pull-request"></a>

### Pull Request 제출하기

- 일찍 피드백을 받고 싶다면 **Draft PR**로 시작해.
- Pull Request Template으로 변경을 설명해. [글쓰기 방식](#writing-style)을 따라.
- PR 설명이나 제목에 Issue를 연결해(예: "Fixes #123").
- UI 변경에는 스크린샷이나 동영상을 추가해.
- 문서 업데이트가 필요한지 밝혀 줘.

<a id="pull-request-policy"></a>

### Pull Request 정책

- PR은 담당자가 배정된 GitHub Issue를 참조해야 해. 배정을 받으려면 Issue에 "Claiming"이라고 댓글을 달아. 그다음 [Discord](https://discord.gg/VxfP4Vx3gX)에서 핵심 팀에 연락해. 핵심 팀이 해당 대화에서 배정을 확인해.
- 연결이 없는 PR은 닫을 수 있어.
- PR은 CI 테스트를 통과하고, 로드맵을 따르며, 명확한 문서를 갖춰야 해.

<a id="review-process"></a>

### 검토 과정

검토할 준비가 된 PR은 다음 조건을 만족해야 해.

- 필수 CI 검사를 통과해.
- 조치가 필요한 검토 피드백에 대응해.
- 유지관리자나 CODEOWNER의 새 승인을 받아. 최신 커밋의 자동 검토가 끝난 뒤에 받아야 해.

자동 검토는 안내 댓글과 시스템이 관리하는 상태 라벨을 추가할 수 있어. 댓글에 있는 다음 단계를 따라. 라벨은 직접 수정하지 마. 새 커밋은 변경된 코드의 검토 상태를 초기화해.

`community-approved` 라벨은 최신 커밋이 커뮤니티의 새 승인을 받았다는 뜻이야. 이후 PR은 유지관리자의 검토를 기다려. 이 라벨은 유지관리자가 우선순위를 정할 때 참고하는 신호야. 유지관리자의 검토나 필수 검사를 대신하지 않아. 검토 워크플로가 라벨을 관리해.

자동 검토는 유지관리자를 도와. 사람의 승인을 대신하지 않아. 외부 기여자는 댓글로 CodeRabbit에 지시할 수 없어. 재시작 조건을 만족하는 검토는 필수 CI가 통과하면 자동으로 다시 시작해. 예외적인 재시작은 유지관리자가 처리해. 저장소 정책에서 달리 정하지 않는 한 경고는 참고 사항이야. GitHub 자체 필수 검사, CODEOWNER 규칙, 검토 보호 설정이 PR 병합 가능 여부를 결정해.

- **매일 분류:** 유지관리자가 빠르게 확인해.
- **매주 심층 검토:** 유지관리자가 전체를 평가해.
- 피드백을 받으면 **빠르게 수정해**.

<a id="pull-request-expectations"></a>

### Pull Request에 기대하는 것

PR은 검토하기 쉽고, 테스트를 마쳤으며, 유지보수하기 쉬워야 해. PR을 열기 전에 다음을 확인해.

- 변경은 구체적인 Issue, 버그, 개선 하나를 다뤄.
- 변경이 하는 일과 올바른 이유를 설명할 수 있어.
- 가능한 경우 네 컴퓨터에서 변경을 테스트했어.
- 검토 피드백에 답하고 합리적인 후속 변경을 할 거야.
- 병합 전에 유지관리자가 변경을 다시 쓰거나 설계하거나 책임을 넘겨받을 필요가 없어.

유지관리자는 다음 이유로 PR을 닫을 수 있어.

- 완성되지 않았어.
- 범위가 너무 넓어.
- 활동이 없어.
- 프로젝트의 방향을 따르지 않아.
- 검토나 유지보수 작업이 너무 많아져.

PR을 닫는 것은 기여자를 평가하는 일이 아니야. 현재 형태로는 변경을 받아들일 수 없다는 뜻이야.

봇도 PR을 자동으로 닫아.

- **60일 동안 활동 없음:** 봇은 60일 동안 활동이 없는 PR에 비활성 표시를 해. 이후 7일 동안도 활동이 없으면 PR을 닫아. 새 댓글, 커밋, 검토는 타이머를 초기화해.
- **작성자가 14일 동안 활동하지 않음:** 검토자가 변경을 요청하면 봇이 `awaiting-author` 라벨을 추가해. 작성자의 활동은 비활성 타이머를 초기화해. 변경이 준비되면 검토자에게 새 검토를 요청해.

PR이 자동으로 닫히지 않게 하려면 `do-not-close`, `pinned`, `work-in-progress` 중 하나의 라벨을 추가해.

<a id="ai-assisted-contributions"></a>

### AI를 활용한 기여

AI 도구를 써도 돼. 제출 내용에 대한 모든 책임은 여전히 너에게 있어.

AI 도구로 PR 작성을 돕는다면 다음을 지켜야 해.

- 중요한 변경을 모두 검토하고 이해해.
- 구현과 절충 사항을 네 말로 설명해.
- 변경을 직접 테스트해. 네 환경에서 테스트할 수 없다면 PR 설명에 이유를 밝혀. 검토자가 변경을 확인할 방법도 설명해.
- 생성된 코드가 올바르고 필요하며 프로젝트 라이선스와 호환되는지 확인해.
- PR 설명에서 AI의 도움을 검토자에게 알릴지 생각해. AI가 코드, 테스트, 설계를 크게 바꿨다면 알려 줘. 검토자가 더 나은 피드백을 주는 데 도움이 돼.

이해하지 못하는 AI 생성 변경은 제출하지 마. 검토 과정에서 유지보수할 수 없는 변경도 제출하지 마. 유지관리자는 AI의 도움이 많이 들어간 것으로 보이는 PR을 닫을 수 있어. 사람의 검증, 명확한 이유, 검토 중 후속 대응이 없을 때 그렇게 할 수 있어.

<a id="writing-style"></a>

### 글쓰기 방식

이 규칙은 영어로 쓴 글에만 적용해. Issue 제목과 본문, PR 제목과 설명, 커밋 메시지는 Simplified Technical English (ASD-STE100)로 작성해. [ASD-STE100](https://www.asd-ste100.org/)을 참고해. Issue와 PR 템플릿에도 같은 안내가 있어.

- 짧은 문장을 써. 지시문은 20단어 이하로 써.
- 쉬운 단어를 써. "utilize" 대신 "use", "commence" 대신 "start"를 써.
- 능동태를 써. "the file is read by the parser" 대신 "the parser reads the file"을 써.
- 한 문장에 한 가지 생각을 담아.
- 축약형, 세미콜론, 긴 대시를 쓰지 마.
- 제목은 짧고 구체적으로 써.
- 정확한 로그, 오류 메시지, 식별자, 명령, 재현 증거는 바꾸지 마. 그대로 붙여 넣어.

이 규칙은 영어 글쓰기 지침이야. 검토자는 공식 ASD-STE100 준수 여부를 검사하지 않아. 코드, 식별자, 명령 구문은 이 규칙에 포함되지 않아.

<a id="legal"></a>

## 법적 사항

기여하면 네 기여에 Apache 2.0 License를 적용하는 데 동의한 것으로 봐. 이것은 Zoo Code의 라이선스야.
