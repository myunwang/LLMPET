# 🐙 LLMPET — ローカル・マルチ Agent デスクトップワークスペース

[简体中文](README.md) | [English](README_EN.md) | **日本語**

LLMPET は、**デスクトップペットを入口にした、ローカル優先のマルチ Agent ワークスペース**です。**Claude Code、OpenAI Codex、DeepSeek Harness** を一つのデスクトップ層にまとめ、実行状態の確認、Session の検索と再表示、ローカル履歴の管理、別 Agent への作業引き継ぎを行えます。

ペットは今も最も直感的なインターフェースです。思考中、ツール実行中、ユーザー待ち、完了、エラー、休憩中といった状態に合わせて表情が変わり、最新の返答を吹き出しで表示します。一方、LLMPET の範囲は監視だけでなく、統合 Session 管理、Agent 間の引き継ぎ、ローカル保管庫と任意バックアップ、利用状況の診断、ユーザーが明示的に開始する Agent 行動へ広がっています。

> **Agent 間引き継ぎの正確な範囲：** Claude と Codex がネイティブ transcript を共有するわけではありません。LLMPET が直近の会話と Git ワークツリー要約をローカルで取り出し、一般的な秘密情報をマスクした一時引き継ぎ資料を作成して、受け側 Agent を起動します。同じ provider 内では公式 resume / fork を使います。DeepSeek Harness は現在、引き継ぎ元としてのみ利用でき、接管先にはなりません。

画面表示は **簡体字中国語、英語、日本語** に対応しています。トレイメニューの `設定 → 言語` から、再起動せずに切り替えられます。

## 主な機能

- **agent の状態をリアルタイム表示** — 思考、作業、並列 subagent、コンテキスト整理、ユーザー待ち、エラー、完了、休憩をアニメーションで表現します。
- **Claude Code の権限確認** — 許可 / 拒否をデスクトップペットから直接選べます。
- **Claude Code + Codex + DeepSeek Harness の複数 Session** — 本体ペットで三つを監視し、Codex と dsh はそれぞれ独立したペットにも分けられます。
- **統合 Session ワークスペース** — ライブおよび履歴 Session の検索、Claude / Codex / DSH / 要対応フィルター、ピン留め、アーカイブ、コンテキスト使用率の確認、対象ウィンドウへの移動ができます。
- **Agent 間の接管** — Claude と Codex の双方向引き継ぎ、および dsh から Claude / Codex への引き継ぎに対応します。同じ provider ではネイティブ resume / fork を使います。
- **ローカル Session 保管庫** — 三つの provider にあるユーザー Session を索引化し、内部 subagent を除外します。任意のバックアップと、既存の元ファイルを上書きしない復元に対応します。
- **ミームアクション** — GIF と音声を再生しながら、対応する構造化 Prompt を選択中のセッションへ送れます。
- **旅するカエル** — 選択した Claude / Codex を独立した読み取り専用の探索へ送り、帰還後にローカルの旅便りを受け取れます。
- **利用状況パネル** — 実 token 推移、モデル別内訳、Claude の API 公開価格換算、Codex のローカル token 台帳、レート制限、診断情報、現在の操作を確認できます。
- **3 種類のスキン** — タコ 🐙、ピクセルモンスター 👾、月薪喵 🐱。
- **macOS のパトロールモード** — 対応する他のデスクトップペットを検出し、最前面を維持しながら相手を画面端へ押し出します。

状態機械、利用量計測、権限処理、プロセス照合、デスクトップ UI はこのリポジトリ内で実装されています。Claude Code は公開 hook API を利用し、Codex と DeepSeek Harness は各自のローカル Session ファイルを読み取り専用で監視します。Agent の設定は変更しません。

## Agent 間の接管の仕組み

```text
引き継ぎ元 Session
├─ 同じ Agent ─────► 公式 resume、元 Session が動作中なら公式 fork
└─ 別の Agent ─────► 直近の会話 + Git status / diff 要約 + 出典情報
                      └─ ローカルでマスクした引き継ぎ資料 ──► 表示可能な接管先 Session
```

引き継ぎ資料の長さには上限があります。`0700` の一時ディレクトリに `0600` のファイルとして保存し、起動成功後は約 2 分、起動失敗時は直ちに削除します。これはネイティブ transcript ではなく引き継ぎ用コンテキストであると明記され、受け側 Agent には無関係な変更を保持し、確認済み事実・未確認事項・残るリスクを分けるよう指示します。現在の接管先は Claude Code と Codex のみで、dsh は引き継ぎ元専用です。

## 月薪喵スキンの状態

| アニメーション | 状態 | 表示されるタイミング |
|:---:|:---|:---|
| <img src="assets/cat/cat-working.gif" width="72" alt="作業中"> <img src="assets/cat/cat-working-2.gif" width="72" alt="作業中の別ポーズ"> | 🛠️ **作業中** | ツール実行、ファイル編集、コマンド実行中 |
| <img src="assets/cat/cat-thinking.gif" width="72" alt="思考中"> <img src="assets/cat/cat-thinking-2.gif" width="72" alt="思考中の別ポーズ"> | 🤔 **思考中** | 最初のツール実行前に考えているとき |
| <img src="assets/cat/cat-talking.gif" width="72" alt="返答中"> | 💬 **返答中** | assistant の返答を生成しているとき |
| <img src="assets/cat/cat-juggling.gif" width="72" alt="並列タスク"> | 🤹 **並列タスク** | 複数の subagent が同時に作業しているとき |
| <img src="assets/cat/cat-waiting.gif" width="72" alt="許可待ち"> | ✋ **許可待ち** | Claude Code が実行許可を求めているとき |
| <img src="assets/cat/cat-needsinput.gif" width="72" alt="入力待ち"> | ❓ **入力待ち** | 回答や選択が必要なとき |
| <img src="assets/cat/cat-happy.gif" width="72" alt="完了"> | 🎉 **完了** | 1 ターンの処理が完了したとき |
| <img src="assets/cat/cat-error.gif" width="72" alt="エラー"> | 💥 **エラー** | コマンドや API リクエストが失敗したとき |
| <img src="assets/cat/cat-loafing.gif" width="72" alt="休憩中"> | 🍦 **小休止** | 前の処理が終わり、次の動作を待っているとき |
| <img src="assets/cat/cat-roam.gif" width="72" alt="旅行中"> | 🧳 **旅行中** | 「旅するカエル」の読み取り専用探索を実行しているとき |
| <img src="assets/cat/cat-sleeping.gif" width="72" alt="睡眠中"> | 😴 **睡眠中** | セッション終了後、または長時間操作がないとき |

月薪喵の素材は Douyin クリエイター **@月薪喵** のものです。詳細は [`assets/cat/CREDITS.md`](assets/cat/CREDITS.md) をご覧ください。

## ソースから起動

ソースからの導入、ローカルパッケージ作成、権限、トラブルシューティングは [ローカル環境への導入](docs/LOCAL_DEPLOYMENT_JA.md) をご覧ください。

必要なもの：

- macOS または Windows
- Node.js 18 以上
- Claude Code または OpenAI Codex（少なくとも一度は利用済み）

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm ci
npm start
```

主なコマンド：

```bash
npm test                 # ヘッドレス回帰テスト一式
npm run package:mac:dev  # ローカル用 ad-hoc 署名 macOS パッケージ
npm run package:win      # Windows インストーラー + ZIP
npm run uninstall:hooks  # LLMPET の Claude hook を安全に削除
```

## 連携の仕組み

### Claude Code

LLMPET は `~/.claude/settings.json` に、既存設定と安全に共存するライフサイクル hook と権限 hook を登録します。

- `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart` などのイベントを、`127.0.0.1` にバインドされたローカルサーバーへ送信します。
- 権限リクエストは、ユーザーが許可または拒否を選ぶまで待機します。
- ローカル transcript は token 数、モデル ID、時刻の集計に必要な範囲で増分走査します。ストリーミング中の usage は正の差分だけを加算し、5 分 / 1 時間の cache write も分けて計算します。assistant の本文は短い返答吹き出しを表示する場合にだけ読み取ります。

### OpenAI Codex

Codex 用の hook はインストールしません。次の rollout を増分かつ読み取り専用で監視します。

```text
~/.codex/sessions/YYYY/MM/DD/*.jsonl
```

rollout イベントを共通の状態機械へ変換し、内部 subagent スレッドを除外します。長時間セッションの復帰時も過去イベントを再生せず、新しく追加された部分だけを読み取ります。各イベントの `last_token_usage` から永続的なローカル token 台帳を作り、レート制限とは分けて表示します。この台帳を OpenAI の請求履歴とは表示しません。

### DeepSeek Harness (dsh)

DeepSeek Harness はまだ **developer preview** で、破壊的変更の可能性があります。LLMPET は未知のログ version を推測せず fail-closed で無視します。dsh 用プラグインはインストールせず、ハーネス自身のセッションログを読み取り専用で監視します。

```text
$DSH_HOME|~/.dsh/sessions/--<プロジェクト>--/<セッション>/session.jsonl.zstd
```

このログは既定で **zstd フレームの連結**です。Electron 33 同梱の Node には zstd API が無いため、LLMPET 自身がフレーム境界を走査し、完全なフレームだけを順に展開します（内蔵の純 JS デコーダ [fzstd](https://github.com/101arrowz/fzstd)、MIT、`backend/vendor/` 参照）。末尾の不完全なフレームは次の巡回まで持ち越します。圧縮フレーム 1 個の展開には 32 MiB の安全上限があり、それを超えたフレームは記録して飛ばし、後続を継続するため監視が永久停止しません。`compression: 'none'` の平文 `session.jsonl` にも対応します。

`turn/start` は思考、そのターン最初の `tool/call` 以降は「作業中」を維持し、`turn/end` は理由に応じて完了祝い / 中断バッジ / エラーになります。`approval/asked` は「返事待ち」（承認は dsh 自身の画面で行います）、`session/title` はそのままセッション名に、`assistant/message.usage` と `request/context.contextWindow` からコンテキスト % を出します。subagent のログ（`origin: 'subagent'`、`delegationDepth > 0`）はファイルごと除外します。

トレイの **🌊 dsh ペット** を有効にすると、見た目・位置・名札が独立した三匹目が現れます（Codex ペットの切り替えとは独立）。無効なら本体ペットが dsh も見ます。「返信しに行く」は汎用の `dsh web` 画面（既定 `http://127.0.0.1:3080`、`LLMPET_DSH_WEB` で上書き）を開きますが、特定の履歴 Session へ正確に移動する保証はありません。`dsh --profile tui --resume <id>` は任意の TUI profile がインストール済みの場合だけ利用でき、検証した rc.6 環境には web/headless しかなかったため、LLMPET は dsh を接管先として表示しません。dsh Session は Claude / Codex への引継ぎ元にはできます。dsh は任意のプロバイダを利用できるため料金台帳は作らず、コンテキスト % のみを表示し、推測の `$0` を料金として表示しません。

## 旅するカエル

セッション右側の **🧳** を押すと、そのセッションの Claude Code / Codex が同じプロジェクトディレクトリへ別行動で出発します。「プロジェクト偵察」「バグ探し」「アイデア散歩」から選ぶか、目的を自由に入力できます。

- セッションパネル下部の **🐱 散歩** は、どの session やプロジェクトとも無関係です。ユーザーに行き先を尋ねず、「遠い町の窓」「生きている手仕事」「地球の不思議な隅」など実在世界のコースをランダムに選び、見える Claude / Codex CLI で少なくとも三つの行程を巡ってから帰ります。
- 散歩で使えるのは公開ウェブ検索と公開ページの閲覧だけです。ファイル、Shell、ログイン、フォーム、アップロードは使えません。選択した CLI が標準のウェブアクセス許可を表示した場合は、見えるターミナルでユーザー自身が許可または拒否できます。拒否は迂回せず、より広い権限も求めません。各旅行は `~/.octopus/wander-home/trips/` 以下の専用の足跡から出発し、最近のコースと記憶を使って同じ散歩の繰り返しを減らします。
- 旅行は同時に 1 件だけで、キャンセル可能、上限は 30 分です。
- 旅便り、状態、実際の呼び出し token は、権限 `0600` の `~/.octopus/travel.json` に保存されます。
- 旅行 token 10,000 ごとに葉を 1 枚獲得し、葉 4 枚 = 星 1 個、星 4 個 = 月 1 個、月 4 個 = 太陽 1 個です。
- LLMPET が自動で旅行を始めることはありません。**出発**を押した場合だけ、目的と必要なプロジェクト文脈が選択した CLI 経由で Anthropic または OpenAI に送られます。

## ミームアクション

各ミームは次の構造で保存されます。

```text
assets/memes/<meme-id>/
  visual.gif
  voice.mp3
```

カタログには表示名、説明、再生方法、ペットの反応、Prompt のバージョン、言語別 Prompt、素材の出所と権利確認状況がまとまっています。GIF / MP3 の実形式とサイズを検証し、内容ハッシュによって再起動なしの差し替えを確実に反映します。詳しくは [`assets/memes/README.md`](assets/memes/README.md) をご覧ください。

言語別 Prompt は逐語訳ではなく、その言語で同じ役割を果たす表現へ置き換えています。たとえば中国語の「你这瓜保熟吗？」は、日本語では「それってあなたの感想ですよね？」となり、どちらも「推測ではなく根拠を出して」という圧を伝えます。

## macOS パトロールモード

ペットの右クリックメニューから **今すぐパトロール** を選ぶか、トレイで自動パトロールを有効にします。

1. **猫の手は常に上：** 対応する他のデスクトップペットを検出すると、LLMPET は最前面レベルを再適用します。
2. **画面端へ押し出す：** アクセシビリティ権限がある場合、相手へ近づき、最寄りの左右端まで移動させます。

ドラッグ helper は、ユーザーがマウスを操作中のときには動作しません。グローバル入力を使う互換処理もアイドル判定で保護され、完了時や失敗時にはマウス状態を復元します。

パトロールモードは現在 macOS のみ対応しています。

## プライバシーとセキュリティ

ライブセッション画面の **📚 保管庫** ボタンから、独立したデスクトップ形式のセッション保管庫を開けます。Claude Code / Codex / 対応 version の DeepSeek Harness にあるユーザー Session をまとめて索引化し、内部 subagent は除外します。Claude / Codex の同一プロバイダーは公式 resume、別プロバイダーはローカル引継ぎ資料を使用し、dsh は現在引継ぎ元のみです。macOS では LLMPET の Dock アイコンを一つだけ常駐させ、クリックすると別インスタンスを作らず保管庫を再表示または前面化します。

定期ローカルバックアップは**初期設定ではオフ**です。ユーザーが明示的に有効にした場合だけ Claude / Codex / DeepSeek Harness の transcript を圧縮形式を変えず `~/.octopus/session-vault` へ差分保存します。復元は消えた transcript のみを再作成し、現在ある元ファイルは上書きしません。プロバイダーの再インストールやローカル履歴の削除には備えられますが、クラウド同期ではなく、ディスク全体の消失には対応できません。

- HTTP サーバーは `127.0.0.1` のみにバインドし、loopback / Host / browser-origin の検証に加えて、書き込み API に起動ごとのランダム token を要求します。
- セッション情報、設定、利用履歴はローカル端末内に保存されます。
- Codex rollout へのアクセスは読み取り専用です。
- バックグラウンド通信は、任意の LiteLLM 公開価格表の日次取得だけです。「旅するカエル」はユーザーが **出発**を押した場合にだけ Anthropic / OpenAI へ接続します。`OCTOPUS_NO_NET=1` は LLMPET の価格取得を止めますが、明示的に開始した CLI 旅行までは無効化しません。
- Electron は `contextIsolation` を有効、`nodeIntegration` を無効にしています。
- Claude hook の追加は既存設定を上書きせず、原子的かつ取り消し可能で、削除前にはバックアップを作成します。

## 設定・開発用フラグ

- `OCTOPUS_NO_HOOKS=1 npm start` — Claude 設定を変更せずに起動します。
- `OCTOPUS_ALLOW_MULTI=1 npm start` — 開発時に単一インスタンス制限を無効化します。
- `OCTOPUS_NO_NET=1 npm start` — 外部ネットワーク通信を無効化します。
- `OCTOPUS_DEBUG=1 npm start` — ローカル `/debug` エンドポイントを有効化します。
- `LLMPET_NO_CODEX=1 npm start` — Codex rollout の監視を無効化します。
- `LLMPET_CODEX_DIR=<dir> npm start` — テスト用の rollout ディレクトリを指定します。
- `LLMPET_NO_DSH=1 npm start` — DeepSeek Harness のセッション監視を無効化します。
- `LLMPET_DSH_DIR=<dir> npm start` — テスト用の dsh セッションディレクトリを指定します。

## コントリビューター

- [@james6666-max](https://github.com/james6666-max) は [PR #6](https://github.com/myunwang/LLMPET/pull/6) で、Windows のセッションフォーカス、ターミナル PID チェーンの解決とキャッシュ、electron-builder パッケージング、Windows CI テストマトリクスを提供しました。
- [@ziyuezhou1](https://github.com/ziyuezhou1) は [PR #16](https://github.com/myunwang/LLMPET/pull/16) の独立実験ブランチで、タブ識別情報の取得、ルートキャッシュの復元、管理者権限 Terminal の対応、検証スクリプトを含む Windows Terminal タブの厳密なフォーカス機能を実装しました。
- [@purrfecto114-lgtm](https://github.com/purrfecto114-lgtm) は [PR #10](https://github.com/myunwang/LLMPET/pull/10) で、CodeWhale 連携、ランタイムセキュリティ、永続化の堅牢化、テスト体系に関する大規模な監査と改善案を提出しました。PR はマージされませんでしたが、その監査と設計への尽力にも感謝します。
- [@andglf](https://github.com/andglf) は [PR #13](https://github.com/myunwang/LLMPET/pull/13) で、並列サブエージェントが同一セッションを共有すると権限リクエストが誤って拒否される問題を、実測データと回帰テストをもとに特定・修正しました。

Issue と Pull Request を歓迎します。
