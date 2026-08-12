<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://discord.gg/VxfP4Vx3gX"><img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=flat&logo=discord&logoColor=white" alt="Join Discord"></a>
          <a href="https://www.reddit.com/r/ZooCode/"><img src="https://img.shields.io/badge/Join%20r%2FZooCode-FF4500?style=flat&logo=reddit&logoColor=white" alt="Join r/ZooCode"></a>
          <a href="https://github.com/Zoo-Code-Org/Zoo-Code/issues"><img src="https://img.shields.io/badge/GitHub-Issues-181717?style=flat&logo=github&logoColor=white" alt="GitHub Issues"></a>
        </p>
        <p align="center">
          <em>すぐに助けが必要なら → <a href="https://discord.gg/VxfP4Vx3gX">Discord に参加</a> • 非同期のほうがいい？→ <a href="https://www.reddit.com/r/ZooCode/">r/ZooCode に参加</a></em>
        </p>

        # Zoo Code

        > あなたのエディタの中に、AIで強化された開発チームを

        ## 私たちは Zoo Code です

> Roo チームが [Roomote](https://roomote.dev/) に注力するため Roo Code の
> 積極的な開発を終了した後、Zoo Code がこのプロジェクトの開発を継続してい
> ます。彼らが築き上げてきたすべてに、Roo チームへ感謝します。
>
> コアチームは、以前 Roo に貢献していた開発者たちで構成されており、この
> プラグインを心から大切に思っています。これからもモデルの更新、バグ修
> 正、機能リリースを続けていき、このプラグインを特別なものにしてくれた
> コミュニティの声に耳を傾けていくつもりです。ぜひ私たちの
> [Discord](https://discord.gg/VxfP4Vx3gX)、
> [Reddit](https://www.reddit.com/r/ZooCode) に参加したり、
> [PR や issue を作成](https://github.com/Zoo-Code-Org/Zoo-Code)したりして
> ください。
>
> _-Zoo Code Team_

## Roo Code から Zoo Code への移行

Roo Code から Zoo Code へ移行するためのクイックガイドは、[Roo→Zoo 移行ガイド](https://docs.zoocode.dev/roo-to-zoo-migration) で確認できます。移行中のユーザーをできるだけ支援したいと考えていて、そのために [Reddit](https://www.reddit.com/r/ZooCode) と [Discord](https://discord.gg/VxfP4Vx3gX) を用意しています。困ったことや質問があれば、気軽に参加して聞いてください。

## Roo Code 以降に Zoo Code が追加した機能

Zoo Code は Roo Code が築いた基盤を引き継ぎ、次の機能で拡張を続けています。

- **Semble コードベースインテリジェンス** — 自動セットアップに対応し、別途インデックス作成を行わずに使える高速なオンデマンドセマンティックコード検索。
- **より強力な Orchestrator ワークフロー** — より安全な委任、並列タスクの調整、親子タスクの確実な復旧、サブタスクとプロバイダープロファイル間の分離を強化。
- **Destructive Command Guard（DCG）による長時間の自律実行** — 信頼できる作業を承認の繰り返しなしで継続しながら、危険なコマンドを自動的にブロック。
- **最新モデル** — Claude、GPT、Gemini、Kimi、GLM、Grok、MiniMax など、新しいモデルファミリーを継続的にサポート。
- **接続方法をさらに拡充** — Zoo Gateway、Moonshot、Kimi Code、Kenari、Friendli、OpenCode Go など、新規および拡張されたプロバイダーに対応。
- **より信頼性の高いターミナルと編集ワークフロー** — ターミナルの早期完了、タスク状態の競合、コンテキスト管理、diff 編集、プロバイダー固有のツール利用に関する問題を修正。
- **ワークスペースをより細かく制御** — ルール管理、モードごとの MCP 制限、マルチルートのパス制御、モデルの reasoning オプション、完了時の変更レビュー操作を追加。

## v3.76.0 の新機能

- **Destructive Command Guard（DCG）で長時間のタスクを中断なく実行** — DCG が危険なコマンドをブロックし、承認ボタンを何度も押さなくても Zoo が作業を継続します。管理対象バイナリのダウンロードとインストールも強化されました。
- **プロバイダーの制御性と信頼性を向上** — OpenAI Codex の応答速度を選択でき、更新された DeepSeek 設定を利用できます。プロバイダープロファイルの変更と実行中タスクの分離も強化されました。
- **ターミナル実行の重要な修正** — Zoo はターミナルコマンドが完了するまで次のステップを開始しなくなり、作業の重複やモデルの早すぎる続行を防ぎます。
- よりスマートなバッチ処理により、関連するツール承認をまとめながら、無関係なリクエストは分離します。
- 障害発生時や同時リクエスト時でも、テレメトリ送信とモデルキャッシュ取得の安定性が向上しました。

## Zoo Codeがあなたのためにできること

- 自然言語の記述からコードを生成
- モードで適応：コード、アーキテクト、質問、デバッグ、カスタムモード
- 既存のコードのリファクタリングとデバッグ
- ドキュメントの作成と更新
- コードベースに関する質問への回答
- 反復的なタスクの自動化
- MCPサーバーの活用

## モード

Zoo Codeは、あなたの働き方に合わせるように適応します。

- コードモード：日常的なコーディング、編集、ファイル操作
- アーキテクトモード：システム、仕様、移行の計画
- 質問モード：迅速な回答、説明、ドキュメント
- デバッグモード：問題の追跡、ログの追加、根本原因の特定
- カスタムモード：チームやワークフローに特化したモードの構築

詳しくは: [モードの使い方](https://docs.zoocode.dev/basic-usage/using-modes) • [カスタムモード](https://docs.zoocode.dev/advanced-usage/custom-modes)

## リソース

- **[ドキュメント](https://docs.zoocode.dev):** Zoo Codeのインストール、設定、習熟のための公式ガイド。
- **[Discordサーバー](https://discord.gg/VxfP4Vx3gX):** コミュニティに参加して、リアルタイムのヘルプやディスカッションに参加できます。
- **[Redditコミュニティ](https://www.reddit.com/r/ZooCode):** あなたの経験を共有し、他の人が何を構築しているかを見ることができます。
- **[GitHub Issues](https://github.com/Zoo-Code-Org/Zoo-Code/issues):** バグを報告し、開発を追跡します。
- **[機能リクエスト](https://github.com/Zoo-Code-Org/Zoo-Code/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop):** アイデアがありますか？開発者と共有してください。

---

## ローカルセットアップと開発

1. **リポジトリをクローンする**:

```sh
git clone https://github.com/Zoo-Code-Org/Zoo-Code.git
```

2. **依存関係をインストールする**:

```sh
pnpm install
```

3. **拡張機能を実行する**:

Zoo Code拡張機能を実行するにはいくつかの方法があります：

### 開発モード (F5)

アクティブな開発には、VSCodeの内蔵デバッグ機能を使用します：

VSCodeで`F5`キーを押すか、**実行** → **デバッグの開始**に移動します。これにより、Zoo Code拡張機能が実行されている新しいVSCodeウィンドウが開きます。

- ウェブビューへの変更はすぐに表示されます。
- コア拡張機能への変更も自動的にホットリロードされます。

### 自動VSIXインストール

拡張機能をVSIXパッケージとしてビルドし、VSCodeに直接インストールするには：

```sh
pnpm install:vsix [-y] [--editor=<command>]
```

このコマンドは次のことを行います：

- どのエディタコマンドを使用するかを尋ねます（code/cursor/code-insiders） - デフォルトは「code」です
- 拡張機能の既存のバージョンをアンインストールします。
- 最新のVSIXパッケージをビルドします。
- 新しくビルドされたVSIXをインストールします。
- 変更を有効にするためにVS Codeを再起動するように求めます。

オプション：

- `-y`: すべての確認プロンプトをスキップし、デフォルト値を使用します
- `--editor=<command>`: エディタコマンドを指定します（例：`--editor=cursor`または`--editor=code-insiders`）

### 手動VSIXインストール

VSIXパッケージを手動でインストールしたい場合：

1.  まず、VSIXパッケージをビルドします：
    ```sh
    pnpm vsix
    ```
2.  `.vsix`ファイルが`bin/`ディレクトリに生成されます（例：`bin/zoo-code-<version>.vsix`）。
3.  VSCode CLIを使用して手動でインストールします：
    ```sh
    code --install-extension bin/zoo-code-<version>.vsix
    ```

---

バージョニングと公開には[changesets](https://github.com/changesets/changesets)を使用しています。リリースノートについては`CHANGELOG.md`をご覧ください。

---

## 免責事項

**ご注意ください**：Zoo Codeは、Zoo Code、関連するサードパーティのツール、またはそれらから生じる出力に関連して提供または利用可能にされたコード、モデル、またはその他のツールに関して、いかなる表明も保証も行いません。お客様は、そのようなツール或いは出力の使用に関連する**すべてのリスク**を負うものとします。そのようなツールは**「現状のまま」**および**「利用可能な限り」**のベースで提供されます。そのようなリスクには、知的財産権の侵害、サイバー脆弱性または攻撃、バイアス、不正確さ、エラー、欠陥、ウイルス、ダウンタイム、財産の損失または損害、および/または人身傷害が含まれますが、これらに限定されません。お客様は、そのようなツールまたは出力の使用（合法性、適切性、およびその結果を含むがこれらに限定されない）について単独で責任を負います。

---

## 貢献

私たちはコミュニティからの貢献を歓迎します！[CONTRIBUTING.md](CONTRIBUTING.md)を読んで始めましょう。

---

## ライセンス

[Apache 2.0 © 2025 Zoo Code Org](../../LICENSE)

---

**Zoo Code を楽しんでください！** しっかり手元で使うにせよ、自律的に動かすにせよ、みなさんが何を作るのか楽しみにしています。質問や機能のアイデアがあれば、[issue](https://github.com/Zoo-Code-Org/Zoo-Code/issues) を開くか、[discussion](https://github.com/Zoo-Code-Org/Zoo-Code/discussions) を始めてください。Happy coding!
