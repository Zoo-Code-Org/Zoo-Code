<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • [日本語](../ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • <b>繁體中文</b>

</sub>
</div>

# 為 Zoo Code 做出貢獻

Zoo Code 是一個由社群驅動的專案，我們非常重視每一份貢獻。為了簡化協作流程，我們採用 [「Issue 優先」的方法](#issue-優先方法)，這意味著所有的 [Pull Request (PR)](#提交-pull-request) 都必須先連結到一個 GitHub Issue。請仔細閱讀本指南。

## 目錄

- [在您貢獻之前](#在您貢獻之前)
- [尋找和規劃您的貢獻](#尋找和規劃您的貢獻)
- [開發和提交流程](#開發和提交流程)
- [Pull Request 的期望](#pull-request-的期望)
- [AI 輔助貢獻](#ai-輔助貢獻)
- [法律](#法律)

## 在您貢獻之前

### 1. 行為準則

所有貢獻者都必須遵守我們的 [行為準則](./CODE_OF_CONDUCT.md)。

### 2. 專案路線圖

我們的路線圖指引著專案的方向。請將您的貢獻與這些關鍵目標保持一致：

### 可靠性第一 (Reliability First)

- 確保差異編輯和命令執行始終可靠。
- 減少阻礙常規使用的摩擦。
- 保證在所有語系和平台上的操作流暢。
- 擴大對各種 AI 供應商和模型的強大支援。

### 增強的使用者體驗 (Enhanced User Experience)

- 簡化 UI/UX，提高清晰度和直覺性。
- 持續改進工作流程，以滿足開發者對日常使用工具的高期望。

### 在 Agent 效能上領先 (Leading on Agent Performance)

- 建立全面的評估基準 (Evals) 來衡量實際應用的生產力。
- 讓每個人都能輕鬆執行和解讀這些評估結果。
- 發布能顯示評估分數有明顯提升的改進。

在您的 PR 中提及與這些領域的一致性。

### 3. 加入 Zoo Code 社群

- **Discord：**加入我們的 [Discord](https://discord.gg/VxfP4Vx3gX)。
- **Reddit：**加入我們的 [Reddit](https://www.reddit.com/r/ZooCode/)。

## 尋找和規劃您的貢獻

### 貢獻類型

- **錯誤修復：** 解決程式碼問題。
- **新功能：** 新增功能。
- **文件：** 改進指南和清晰度。

### Issue 優先方法

所有貢獻都始於使用我們精簡範本的 GitHub Issue。

- **檢查現有 Issue**：在 [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues) 中搜尋。
- **使用以下範本建立 Issue**：
    - **增強功能：** 「Enhancement Request」範本（著重於使用者利益的淺顯描述）。
    - **錯誤** 「Bug Report」範本（最少的重現步驟 + 預期與實際結果 + 版本）。
- **想參與其中嗎？** 在 Issue 上留言「Claiming」，並在 [Discord](https://discord.gg/VxfP4Vx3gX) 上聯繫核心團隊以獲得分配。分配結果將在討論串中確認。
- **PR 必須連結到 Issue。** 未連結的 PR 可能會被關閉。

### 決定做什麼

- 若要查看 issue，請前往 [GitHub Issues 頁面](https://github.com/Zoo-Code-Org/Zoo-Code/issues)。
- 如需文件，請造訪 [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs)。

### 回報錯誤

- 首先檢查現有的報告。
- 使用 [「Bug Report」範本](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose) 建立一個新的錯誤回報，並提供：
    - 清晰、編號的重現步驟
    - 預期與實際結果
    - Zoo Code 版本（必填）；如果相關，還需提供 API 供應商/模型
- **安全問題**：透過 [安全公告 (Security Advisories)](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new) 私下回報。

## 開發和提交流程

### 開發設定

1. **Fork 與 Clone：**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **安裝相依套件：**

```
pnpm install
```

3. **偵錯：** 使用 VS Code 開啟（`F5`）。

### 程式碼撰寫指南

- 每個功能或修復使用一個單一目的的 PR。
- 遵循 ESLint 和 TypeScript 的最佳實務。
- 撰寫清晰、描述性的 Commit 訊息，並引用 Issue（例如，`Fixes #123`）。
- 提供全面的測試（`npm test`）。
- 在提交前 Rebase 到最新的 `main` 分支。

### 提交 Pull Request

- 如果希望獲得早期回饋，請以 **Draft PR** 開始。
- 遵循 Pull Request 範本，清晰地描述您的變更。
- 在 PR 描述/標題中連結 Issue（例如，「Fixes #123」）。
- 為使用者介面變更提供螢幕截圖/影片。
- 指明是否需要更新文件。

### Pull Request 政策

- 必須引用一個已指派的 GitHub Issue。如要被指派：請在 Issue 上留言「Claiming」，並在 [Discord](https://discord.gg/VxfP4Vx3gX) 上聯繫核心團隊。指派結果將可在討論串中確認。
- 未連結 Issue 的 PR 可能會被關閉。
- PR 必須通過 CI 測試，與路線圖保持一致，並有清晰的文件。

### 審查流程

- **每日 Triage：** 維護者進行快速檢查。
- **每週深入審查：** 全面評估。
- **根據回饋及時迭代**。

### Pull Request 的期望

Pull Request 應當可審查、經過測試且可維護。在開啟 PR 之前，請確保：

- 變更僅限於特定的問題、錯誤或改進。
- 您能夠解釋變更的內容以及為何正確。
- 您已在可行的情況下在本地測試了變更。
- 您願意回應審查意見並進行合理的後續更改。
- PR 無需維護者在合併之前實質性地重寫、重新設計或接管實作。

維護者可以關閉不完整、範圍過廣、不活躍、與專案方向不符或產生不相稱的審查或維護負擔的 PR。關閉 PR 不是對貢獻者的評判；這是維護者認為該變更以其現有形式無法被接受的決定。

### AI 輔助貢獻

允許使用 AI 工具，但貢獻者對其提交內容負全部責任。

如果您使用 AI 工具協助建立 PR，您必須：

- 審查並理解每一項有意義的變更。
- 能夠用自己的話解釋實作方式和取捨。
- 自行測試變更。如果在您的環境中測試不可行，請在 PR 說明中說明原因，並描述審查者如何驗證該變更。
- 驗證生成的程式碼是否正確、必要且與專案授權條款相容。
- 當 AI 對程式碼、測試或設計有實質性影響時，建議在 PR 說明中揭露 AI 輔助情況 — 這有助於審查者提供更好的回饋。

請勿提交您不理解或無法在審查過程中維護的 AI 生成變更。維護者可能會關閉看似主要由 AI 輔助但缺乏人工驗證、明確理由或審查跟進的 PR。

## 法律資訊

透過貢獻，您同意您的貢獻將根據 Apache 2.0 授權條款進行授權，這與 Zoo Code 的授權一致。
