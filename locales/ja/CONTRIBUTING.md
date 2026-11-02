<div align="center">
<sub>

[English](../../CONTRIBUTING.md) • [Català](../ca/CONTRIBUTING.md) • [Deutsch](../de/CONTRIBUTING.md) • [Español](../es/CONTRIBUTING.md) • [Français](../fr/CONTRIBUTING.md) • [हिंदी](../hi/CONTRIBUTING.md) • [Bahasa Indonesia](../id/CONTRIBUTING.md) • [Italiano](../it/CONTRIBUTING.md) • <b>日本語</b>

</sub>
<sub>

[한국어](../ko/CONTRIBUTING.md) • [Nederlands](../nl/CONTRIBUTING.md) • [Polski](../pl/CONTRIBUTING.md) • [Português (BR)](../pt-BR/CONTRIBUTING.md) • [Русский](../ru/CONTRIBUTING.md) • [Türkçe](../tr/CONTRIBUTING.md) • [Tiếng Việt](../vi/CONTRIBUTING.md) • [简体中文](../zh-CN/CONTRIBUTING.md) • [繁體中文](../zh-TW/CONTRIBUTING.md)

</sub>
</div>

<a id="contributing-to-zoo-code"></a>

# Zoo Code への貢献

Zoo Code はコミュニティのプロジェクトだ。すべての貢献を大切にしている。[Issue-First](#issue-first-approach) の方針で進める。つまり、すべての [Pull Request（PR）](#submitting-a-pull-request) は GitHub Issue にリンクする必要がある。このガイドをよく読んでほしい。

<a id="table-of-contents"></a>

## 目次

- [貢献する前に](#before-you-contribute)
- [貢献する内容を探して計画する](#finding--planning-your-contribution)
- [開発と提出の流れ](#development--submission-process)
    - [Pull Request に求めること](#pull-request-expectations)
    - [AI を使った貢献](#ai-assisted-contributions)
    - [文章の書き方](#writing-style)
- [法的事項](#legal)

<a id="before-you-contribute"></a>

## 貢献する前に

<a id="1-code-of-conduct"></a>

### 1. 行動規範

すべての貢献者は[行動規範](./CODE_OF_CONDUCT.md)を守る必要がある。

<a id="2-project-roadmap"></a>

### 2. プロジェクトのロードマップ

ロードマップはプロジェクトの方向性を示す。次の目標に沿って貢献しよう。

<a id="reliability-first"></a>

### 信頼性を最優先に

- diff による編集とコマンド実行を、毎回確実に動くようにする。
- Zoo Code を毎日使う妨げになる問題を取り除く。
- すべてのロケールとプラットフォームで Zoo Code を動かす。
- より多くの AI プロバイダーとモデルに対応する。

<a id="enhanced-user-experience"></a>

### 使いやすさの向上

- UI と UX をわかりやすく、使いやすくする。
- 作業の流れを改善する。開発者は毎日使うツールに高い品質を求める。

<a id="leading-on-agent-performance"></a>

### エージェントの性能を高める

- 実際の生産性を測る評価ベンチマーク（evals）を作る。
- evals を実行しやすく、読みやすくする。
- evals のスコアを明確に高める改善を届ける。

PR では、変更がどの分野を支えるかを説明しよう。

<a id="3-join-the-zoo-code-community"></a>

### 3. Zoo Code コミュニティに参加する

- **Discord:** [Discord](https://discord.gg/VxfP4Vx3gX) に参加しよう。
- **Reddit:** [Reddit](https://www.reddit.com/r/ZooCode/) に参加しよう。

<a id="finding--planning-your-contribution"></a>

## 貢献する内容を探して計画する

<a id="types-of-contributions"></a>

### 貢献の種類

- **バグ修正:** コードの問題を直す。
- **新機能:** 機能を追加する。
- **ドキュメント:** ガイドを改善して、わかりやすくする。

<a id="issue-first-approach"></a>

### Issue-First の進め方

どの貢献も GitHub Issue から始める。短いテンプレートを使おう。

- **既存の Issue を確認する**: [GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues) を検索しよう。
- **Issue を作る**ときは次を使う。
    - **改善:** "Enhancement Request" テンプレート（利用者への利点を中心に、わかりやすい言葉で書く）。
    - **バグ:** "Bug Report" テンプレート（最小限の再現手順、期待した結果と実際の結果、バージョン）。
- **Issue を書く**ときは、下の[文章の書き方](#writing-style)に従おう。
- **担当したい？** Issue に "Claiming" とコメントしよう。その後、[Discord](https://discord.gg/VxfP4Vx3gX) でコアチームに連絡して担当を依頼しよう。コアチームがスレッド内で担当を確認する。
- **PR は Issue にリンクする必要がある。** リンクがない PR は閉じることがある。

<a id="deciding-what-to-work-on"></a>

### 取り組む内容を決める

- [GitHub Issues のページ](https://github.com/Zoo-Code-Org/Zoo-Code/issues)を見よう。
- ドキュメントについては [Zoo Code Docs](https://github.com/Zoo-Code-Org/Zoo-Code-Docs) を見よう。

<a id="reporting-bugs"></a>

### バグを報告する

- まず既存の報告を確認しよう。
- ["Bug Report" テンプレート](https://github.com/Zoo-Code-Org/Zoo-Code/issues/new/choose)で新しいバグ報告を作り、次を含めよう。
    - わかりやすい、番号付きの再現手順
    - 期待した結果と実際の結果
    - Zoo Code のバージョン（必須）
    - 関係がある場合は API プロバイダーとモデル
- **セキュリティの問題**: [セキュリティアドバイザリ](https://github.com/Zoo-Code-Org/Zoo-Code/security/advisories/new)で非公開の報告をしよう。

<a id="development--submission-process"></a>

## 開発と提出の流れ

<a id="development-setup"></a>

### 開発環境の準備

1. **フォークしてクローンする:**

```
git clone https://github.com/YOUR_USERNAME/Zoo-Code.git
```

2. **依存関係をインストールする:**

```
pnpm install
```

3. **デバッグ:** VS Code で開く（`F5`）。

<a id="writing-code-guidelines"></a>

### コードを書くときの指針

- 機能や修正ごとに、目的を絞った PR を 1 つ作ろう。
- ESLint と TypeScript のベストプラクティスに従おう。
- Issue を参照する、わかりやすく内容を説明したコミットを書こう（例: `Fixes #123`）。[文章の書き方](#writing-style)に従おう。
- 変更を十分にテストしよう（`npm test`）。
- 提出前に最新の `main` ブランチへリベースしよう。

<a id="submitting-a-pull-request"></a>

### Pull Request を提出する

- 早めに意見が欲しい場合は **Draft PR** から始めよう。
- Pull Request Template で変更を説明しよう。[文章の書き方](#writing-style)に従おう。
- PR の説明かタイトルで Issue をリンクしよう（例: "Fixes #123"）。
- UI の変更にはスクリーンショットや動画を追加しよう。
- ドキュメントの更新が必要かどうかを書こう。

<a id="pull-request-policy"></a>

### Pull Request の方針

- PR は担当が割り当てられた GitHub Issue を参照する必要がある。担当するには、Issue に "Claiming" とコメントしよう。その後、[Discord](https://discord.gg/VxfP4Vx3gX) でコアチームに連絡しよう。コアチームがスレッド内で担当を確認する。
- リンクがない PR は閉じることがある。
- PR は CI テストに合格し、ロードマップに沿い、わかりやすいドキュメントを備える必要がある。

<a id="review-process"></a>

### レビューの流れ

レビューに出す PR は、次の条件を満たす必要がある。

- 必須の CI チェックに合格している。
- 対応が必要なレビューの指摘に対応している。
- メンテナーまたは CODEOWNER から新たな承認を得ている。これは最新のコミットの自動レビューが終わった後に行う。

自動レビューは、案内コメントとシステムが管理する状態ラベルを追加することがある。コメントにある次の手順に従おう。ラベルを自分で編集してはいけない。新しいコミットは、変更したコードのレビュー状態をリセットする。

`community-approved` ラベルは、最新のコミットに対する新たなコミュニティの承認を示す。その後、PR はメンテナーのレビューを待つ。このラベルは、メンテナーが優先度を判断するための参考情報だ。メンテナーのレビューや必須チェックの代わりにはならない。レビューのワークフローがラベルを管理する。

自動レビューはメンテナーを助ける。人による承認の代わりにはならない。外部の貢献者はコメントで CodeRabbit に指示できない。再開の条件を満たすレビューは、必須の CI が通ると自動で再開する。例外的な再開はメンテナーが扱う。警告は参考情報だが、リポジトリの方針が別の扱いを定める場合もある。GitHub 標準の必須チェック、CODEOWNER の規則、レビュー保護が、PR をマージできるかを決める。

- **毎日の仕分け:** メンテナーが簡単な確認をする。
- **毎週の詳しいレビュー:** メンテナーが全体を評価する。
- 意見を受け取ったら**すばやく修正しよう**。

<a id="pull-request-expectations"></a>

### Pull Request に求めること

PR はレビューしやすく、テスト済みで、保守しやすい必要がある。PR を開く前に、次を確認しよう。

- 変更が 1 つの具体的な Issue、バグ、改善に絞られている。
- 変更の内容と、それが正しい理由を説明できる。
- 可能な範囲で、自分のコンピューターで変更をテストした。
- レビューの意見に答え、妥当な追加変更をするつもりがある。
- マージする前に、メンテナーが変更を書き直したり、設計し直したり、担当を引き取ったりする必要がない。

メンテナーは次の理由で PR を閉じることがある。

- 未完成である。
- 範囲が広すぎる。
- 活動が止まっている。
- プロジェクトの方向性に合っていない。
- レビューや保守にかかる作業が多すぎる。

PR を閉じることは、貢献者への評価ではない。今の形では変更を受け入れられないという意味だ。

ボットも PR を自動で閉じる。

- **60 日間活動がない場合:** ボットは 60 日間活動がない PR に停滞の印を付ける。その後さらに 7 日間活動がなければ PR を閉じる。新しいコメント、コミット、レビューでタイマーがリセットされる。
- **作者が 14 日間活動していない場合:** レビュアーが変更を求めると、ボットが `awaiting-author` ラベルを追加する。作者の活動で非活動タイマーがリセットされる。変更の準備ができたら、レビュアーに再レビューを頼もう。

PR の自動終了を止めるには、`do-not-close`、`pinned`、`work-in-progress` のいずれかのラベルを追加しよう。

<a id="ai-assisted-contributions"></a>

### AI を使った貢献

AI ツールは使ってよい。ただし、提出内容の責任はすべて自分で負う。

AI ツールを使って PR を作る場合は、次を守ろう。

- 重要な変更をすべて確認し、理解する。
- 実装とトレードオフを自分の言葉で説明する。
- 自分で変更をテストする。自分の環境でテストできない場合は、PR の説明に理由を書く。レビュアーが変更を確認する方法も書く。
- 生成されたコードが正しく、必要で、プロジェクトのライセンスと互換性があることを確認する。
- PR の説明で AI の使用をレビュアーに伝えるか検討する。AI がコード、テスト、設計を大きく変えた場合は伝えよう。レビュアーがよりよい意見を出す助けになる。

理解していない AI 生成の変更を提出してはいけない。レビュー中に保守できない変更も提出してはいけない。メンテナーは、AI の関与が大きいと思われる PR を閉じることがある。人による検証、明確な理由、レビューへの継続的な対応がない場合が該当する。

<a id="writing-style"></a>

### 文章の書き方

この規則は英語の文章だけに適用する。Issue のタイトルと本文、PR のタイトルと説明、コミットメッセージは Simplified Technical English (ASD-STE100) で書こう。[ASD-STE100](https://www.asd-ste100.org/) を参照しよう。Issue と PR のテンプレートにも同じ注意書きがある。

- 短い文を使う。指示は 20 語以内にする。
- 平易な言葉を使う。"utilize" ではなく "use"、"commence" ではなく "start" と書く。
- 能動態を使う。"the file is read by the parser" ではなく "the parser reads the file" と書く。
- 1 つの文には 1 つの考えを書く。
- 短縮形、セミコロン、em ダッシュを使わない。
- タイトルは短く具体的にする。
- 正確なログ、エラーメッセージ、識別子、コマンド、再現の証拠を変更しない。そのまま貼り付ける。

この規則は英語を書くための指針だ。レビュアーは正式な ASD-STE100 準拠を確認しない。コード、識別子、コマンド構文はこの規則の対象外だ。

<a id="legal"></a>

## 法的事項

貢献すると、自分の貢献に Apache 2.0 License を適用することに同意したことになる。これは Zoo Code のライセンスだ。
