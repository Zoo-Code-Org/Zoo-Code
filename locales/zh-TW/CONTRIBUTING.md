<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • <b>繁體中文</b>

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# 為 Zoo Code 做出貢獻

Zoo Code 是社群專案。我們重視每一份貢獻。我們採用[先建 Issue](#issue-first-approach) 的方式。這表示每個 [Pull Request（PR）](#submitting-a-pull-request) 都必須連結到一個 GitHub Issue。請仔細閱讀這份指南。

<a id="table-of-contents"></a>

## 目錄

- [貢獻前的準備](#before-you-contribute)
- [尋找與規劃你的貢獻](#finding--planning-your-contribution)
- [開發與提交流程](#development--submission-process)
    - [Pull Request 要求](#pull-request-expectations)
    - [AI 輔助貢獻](#ai-assisted-contributions)
    - [寫作風格](#writing-style)
- [法律條款](#legal)

<a id="before-you-contribute"></a>

## 貢獻前的準備

<a id="1-code-of-conduct"></a>

### 1. 行為準則

所有貢獻者都必須遵守我們的[行為準則](./CODE_OF_CONDUCT.md)。

<a id="2-project-roadmap"></a>

### 2. 專案路線圖

路線圖顯示專案的發展方向。請讓你的貢獻符合這些目標：

<a id="reliability-first"></a>

### 可靠性優先

- 讓 diff 編輯與指令執行每次都可靠。
- 解決妨礙大家每天使用 Zoo Code 的問題。
- 讓 Zoo Code 支援所有語言地區與平台。
- 支援更多 AI 供應商與模型。

<a id="enhanced-user-experience"></a>

### 改善使用者體驗

- 讓 UI 與 UX 清楚、易用。
- 改善工作流程。開發者對每天使用的工具有很高的要求。

<a id="leading-on-agent-performance"></a>

### 領先的代理效能

- 建立能衡量實際生產力的評估基準（evals）。
- 讓 evals 容易執行與閱讀。
- 發布能明顯提高 evals 分數的改進。

在 PR 中說明你的變更支持上述哪些方向。

<a id="3-join-the-zoo-code-community"></a>

### 3. 加入 Zoo Code 社群

- **Discord：** 加入我們的 [Discord](https://discord.gg/VxfP4Vx3gX)。
- **Reddit：** 加入我們的 [Reddit](https://www.reddit.com/r/ZooCode/)。

<a id="finding--planning-your-contribution"></a>

## 尋找與規劃你的貢獻

<a id="types-of-contributions"></a>

### 貢獻類型

- **修正錯誤：** 修正程式碼問題。
- **新功能：** 新增功能。
- **文件：** 改善指南，讓內容更清楚。

<a id="issue-first-approach"></a>

### 先建 Issue

每份貢獻都從一個 GitHub Issue 開始。請使用我們的簡短範本。

- **檢查現有 Issue：** 搜尋 [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues)。
- **建立 Issue** 時使用：
    - **改進：** 「Enhancement Request」範本（使用簡單的語言，重點說明對使用者的好處）。
    - **錯誤：** 「Bug Report」範本（最小重現範例、預期與實際結果、版本）。
- **撰寫 Issue** 時遵循下方的[寫作風格](#writing-style)。
- **想接手這項工作？** 在 Issue 中留言「Claiming」。接著在 [Discord](https://discord.gg/VxfP4Vx3gX) 聯絡核心團隊，讓他們把 Issue 指派給你。核心團隊會在討論串中確認指派。
- **PR 必須連結到 Issue。** 我們可能關閉沒有連結的 PR。

<a id="deciding-what-to-work-on"></a>

### 決定做什麼

- 查看 [GitHub Issues 頁面](https://github.com/Zoo-Code-Org/Zoo-Code/issues)。
- 文件相關工作請前往 [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs)。

<a id="reporting-bugs"></a>

### 回報錯誤

- 先檢查現有回報。
- 使用[「Bug Report」範本](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose)建立新的錯誤回報，並提供：
    - 清楚、有編號的重現步驟
    - 預期結果與實際結果
    - Zoo Code 版本（必填）
    - API 供應商與模型（如與問題相關）
- **安全問題：** 透過 [security advisories](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new) 私下回報。

<a id="development--submission-process"></a>

## 開發與提交流程

<a id="development-setup"></a>

### 設定開發環境

1. **Fork 並複製：**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **安裝相依套件：**

```
pnpm install
```

3. **偵錯：** 用 VS Code 開啟（`F5`）。

<a id="writing-code-guidelines"></a>

### 撰寫程式碼的指南

- 每個功能或修正只提交一個專注於該項工作的 PR。
- 遵循 ESLint 與 TypeScript 的最佳實務。
- 撰寫清楚、有說明性的 commit 訊息，並參照 Issue（例如 `Fixes #123`）。遵循[寫作風格](#writing-style)。
- 完整測試你的變更（`npm test`）。
- 提交前，rebase 到最新的 `main` 分支。

<a id="submitting-a-pull-request"></a>

### 提交 Pull Request

- 如果想及早取得回饋，先建立 **Draft PR**。
- 使用 Pull Request Template 描述變更。遵循[寫作風格](#writing-style)。
- 在 PR 說明或標題中連結 Issue（例如「Fixes #123」）。
- UI 變更需加入螢幕截圖或影片。
- 說明變更是否需要更新文件。

<a id="pull-request-policy"></a>

### Pull Request 政策

- PR 必須參照一個已指派的 GitHub Issue。要取得指派，先在 Issue 中留言「Claiming」。接著在 [Discord](https://discord.gg/VxfP4Vx3gX) 聯絡核心團隊。核心團隊會在討論串中確認指派。
- 我們可能關閉沒有連結的 PR。
- PR 必須通過 CI 測試、符合路線圖，並有清楚的文件。

<a id="review-process"></a>

### 審查流程

準備好接受審查的 PR 必須符合以下條件：

- 通過必要的 CI 檢查。
- 處理需要採取行動的審查回饋。
- 取得維護者或 CODEOWNER 的最新核准。核准必須發生在最新 commit 的自動審查完成之後。

自動審查可能加入指引留言與受管理的狀態標籤。按照留言中的下一步操作。不要自行修改標籤。新的 commit 會重設已變更程式碼的審查狀態。

`community-approved` 標籤表示最新 commit 取得了社群的最新核准。接著，PR 等待維護者審查。這個標籤提供維護者優先順序的參考。它不能取代維護者審查或必要的檢查。審查工作流程管理這個標籤。

自動審查協助維護者，但不能取代人工核准。外部貢獻者不能透過留言指揮 CodeRabbit。符合條件的審查會在必要的 CI 通過後自動重新開始。維護者處理例外情況下的重啟。除非儲存庫政策另有規定，否則警告僅供參考。GitHub 原生的必要檢查、CODEOWNER 規則與審查保護決定 PR 能否合併。

- **每日初步檢查：** 維護者進行快速檢查。
- **每週深入審查：** 維護者進行完整評估。
- 收到回饋後，**盡快調整**。

<a id="pull-request-expectations"></a>

### Pull Request 要求

PR 必須容易審查、經過測試，並且容易維護。開啟 PR 前，確認以下幾點：

- 變更只針對一個具體的 Issue、錯誤或改進。
- 你能解釋變更做了什麼，以及為什麼正確。
- 你已盡可能在自己的電腦上測試變更。
- 你會回應審查回饋，並進行合理的後續修改。
- 合併前，維護者不需要重寫、重新設計或接管變更。

維護者可能因以下原因關閉 PR：

- 內容不完整。
- 範圍太廣。
- 沒有活動。
- 不符合專案方向。
- 產生過多的審查或維護工作。

關閉 PR 不是對貢獻者的評斷。這表示維護者無法接受目前形式的變更。

機器人也會自動關閉 PR：

- **60 天無活動：** PR 連續 60 天沒有活動後，機器人會將它標記為過期。如果再過 7 天仍沒有活動，機器人會關閉 PR。新的留言、commit 或審查會重設計時器。
- **作者 14 天無活動：** 審查者要求修改時，機器人會加入 `awaiting-author` 標籤。作者的活動會重設無活動計時器。變更準備好後，請向審查者要求再次審查。

要阻止 PR 自動關閉，請加入 `do-not-close`、`pinned` 或 `work-in-progress` 標籤。

<a id="ai-assisted-contributions"></a>

### AI 輔助貢獻

你可以使用 AI 工具，但仍須對提交內容負全部責任。

如果你使用 AI 工具協助建立 PR，你必須：

- 審查並理解每項重要變更。
- 用自己的話解釋實作方式與取捨。
- 自行測試變更。如果無法在你的環境中測試，請在 PR 說明中解釋原因。也要說明審查者如何驗證變更。
- 確認產生的程式碼正確、必要，且與專案授權條款相容。
- 考慮在 PR 說明中告知審查者 AI 的協助。如果 AI 大幅改變了程式碼、測試或設計，就應說明。這有助於審查者提供更好的回饋。

不要提交你不理解的 AI 產生變更。不要提交你無法在審查期間維護的變更。維護者可能關閉看起來大量依賴 AI 的 PR。如果缺少人工驗證、明確理由或審查跟進，他們可以這樣做。

<a id="writing-style"></a>

### 寫作風格

這些規則只適用於英文文字。Issue 標題與內容、PR 標題與說明，以及 commit 訊息應使用 [Simplified Technical English (ASD-STE100)](https://www.asd-ste100.org/)。Issue 與 PR 範本也有相同的提醒。

- 使用短句。每條指令不超過 20 個單字。
- 使用簡單詞語。寫「use」，不要寫「utilize」。寫「start」，不要寫「commence」。
- 使用主動語態。寫「the parser reads the file」，不要寫「the file is read by the parser」。
- 每句只表達一個想法。
- 不要使用縮約形式、分號或長破折號。
- 標題保持簡短、具體。
- 不要變更確切的紀錄、錯誤訊息、識別字、指令或重現證據。請原樣貼上。

這些規則是寫作指引。審查者不會檢查是否正式符合 ASD-STE100。程式碼、識別字與指令語法不在這條規則的範圍內。

<a id="legal"></a>

## 法律條款

參與貢獻即表示你同意以 Apache 2.0 授權條款發布你的貢獻。這也是 Zoo Code 使用的授權條款。
