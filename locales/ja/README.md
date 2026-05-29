<p align="center">
          <a href="https://marketplace.visualstudio.com/items?itemName=ZooCodeOrganization.zoo-code"><img src="https://img.shields.io/badge/VS_Code_Marketplace-007ACC?style=flat&logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace"></a>
          <a href="https://x.com/ZooCodeDev"><img src="https://img.shields.io/badge/ZooCode-000000?style=flat&logo=x&logoColor=white" alt="X"></a>
          <a href="https://youtube.com/@roocodeyt?feature=shared"><img src="https://img.shields.io/badge/YouTube-FF0000?style=flat&logo=youtube&logoColor=white" alt="YouTube"></a>
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

> Roo チーム 🦘🦘🦘 の[最近の発表](https://x.com/mattrubens/status/2046636598859559114)を見たかもしれません。要するに、チームは [Roomote](https://roomote.dev/) に注力するため、Roo Code の積極的な開発を段階的に縮小しています。この知らせは多くの Roo ユーザーにとってつらいものでした。このプラグインはこのコミュニティにとってとても大切な存在です。
>
> このプラグインに注いでくれた努力に対して、Roo チーム全員に感謝したいと思います。ここで一人ひとりの名前を挙げることはしませんが、彼らが優れた開発者であり、同じくらい素晴らしい人たちであることに、みんなが同意できるはずです。Roo チームに感謝します。
>
> Roo ユーザーには本当にいろいろな人がいます。日々の仕事でプロとして使っている人もいれば、信じられないほど複雑なワークフローを考えるために使っている人もいます。Roo 自体を改善するために使う人もいれば、Roo が使っているモデルそのものを改善するために使う人もいます（超メタです）。言いたいのは、コミュニティは多様だということです。カンガルー 🦘🦘🦘 も立派で高貴な動物ですが、さまざまな種が集まる「Zoo」🐘🦡🦒🦓🦛🦧🦭🦦 のほうが、このプラグインのユーザーの多様性をよりよく表していると感じました。
>
> そこで、**Zoo Code** がこの重要なプロジェクトの開発を継続することをお知らせします。コアチームは、以前 Roo に貢献していた開発者たちで構成されており、このプラグインを心から大切に思っています。これからもモデルの更新、バグ修正、機能リリースを続けていきます。ですが何よりも、このプラグインを特別なものにしてくれたコミュニティのみなさんの声に耳を傾けたいと考えています。ぜひ私たちの [Discord](https://discord.gg/VxfP4Vx3gX)、[Reddit](https://www.reddit.com/r/ZooCode) に参加したり、[PR や issue を作成](https://github.com/Zoo-Code-Org/Zoo-Code)したりしてください。何よりも、コミュニティとして関わり続け、つながり続け、活発でいてほしいと願っています。
>
> _-Zoo Code Team_

## Roo Code から Zoo Code への移行

Roo Code から Zoo Code へ移行するためのクイックガイドは、[Roo→Zoo 移行ガイド](https://docs.zoocode.dev/roo-to-zoo-migration) で確認できます。移行中のユーザーをできるだけ支援したいと考えていて、そのために [Reddit](https://www.reddit.com/r/ZooCode) と [Discord](https://discord.gg/VxfP4Vx3gX) を用意しています。困ったことや質問があれば、気軽に参加して聞いてください。

## v3.56.0 の新機能

- Anthropic・Bedrock・Vertex で **Claude Opus 4.8** をサポート
- **Opencode Go** を新たな正式 API プロバイダーとして追加
- **タスクキャンセルの改善** — タスクをキャンセルすると実行中のプロセスが正しく終了。応答しないプロセスには Ctrl+C の自動リトライも実施
- Gemini のカスタムモデル ID が無視されてデフォルトにフォールバックする問題を修正
- マーカー欠落による Grok diff の切り捨てを修正
- シェルプロファイルが未設定の Windows での PowerShell 検出を修正
- VS Code コードアクションが Roo Code のブランド名を表示していた問題を修正。全サポート言語にローカライズ済み
- Google Cloud 認証情報フィールドにファイルパスを受け取った際の Vertex AI の誤警告を修正
- 6 件のセキュリティ依存関係更新 (diff, i18next-http-backend, fast-xml-parser, simple-git, uuid, turbo)

---

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

## チュートリアルと機能のビデオ

<div align="center">

|                                                                                                                                                                              |                                                                                                                                                                          |                                                                                                                                                                                      |
| :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| <a href="https://www.youtube.com/watch?v=Mcq3r1EPZ-4"><img src="https://img.youtube.com/vi/Mcq3r1EPZ-4/maxresdefault.jpg" width="100%"></a><br><b>Zoo Codeのインストール</b> | <a href="https://www.youtube.com/watch?v=ZBML8h5cCgo"><img src="https://img.youtube.com/vi/ZBML8h5cCgo/maxresdefault.jpg" width="100%"></a><br><b>プロファイルの設定</b> | <a href="https://www.youtube.com/watch?v=r1bpod1VWhg"><img src="https://img.youtube.com/vi/r1bpod1VWhg/maxresdefault.jpg" width="100%"></a><br><b>コードベースのインデックス作成</b> |
|     <a href="https://www.youtube.com/watch?v=iiAv1eKOaxk"><img src="https://img.youtube.com/vi/iiAv1eKOaxk/maxresdefault.jpg" width="100%"></a><br><b>カスタムモード</b>     |  <a href="https://www.youtube.com/watch?v=Ho30nyY332E"><img src="https://img.youtube.com/vi/Ho30nyY332E/maxresdefault.jpg" width="100%"></a><br><b>チェックポイント</b>  |        <a href="https://www.youtube.com/watch?v=HmnNSasv7T8"><img src="https://img.youtube.com/vi/HmnNSasv7T8/maxresdefault.jpg" width="100%"></a><br><b>コンテキスト管理</b>        |

</div>
<p align="center">
<a href="https://docs.zoocode.dev/tutorial-videos">その他のクイックチュートリアルと機能のビデオ...</a>
</p>

## リソース

- **[ドキュメント](https://docs.zoocode.dev):** Zoo Codeのインストール、設定、習熟のための公式ガイド。
- **[YouTubeチャンネル](https://youtube.com/@roocodeyt?feature=shared):** チュートリアルを見て、実際の機能を確認できます。
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
