# LLMPET をローカル環境へ導入する

このガイドでは、ソースからの起動・テストと、ローカル開発検証用パッケージの作成を説明します。

## 対応環境

| プラットフォーム | ソースから起動 | 備考 |
| --- | --- | --- |
| macOS Apple Silicon | 対応 | パトロールにはアクセシビリティ権限が必要 |
| Windows x64 | 対応 | セッションフォーカス、パトロール、Codex ペット略奪、ミームに対応 |
| Linux | 正式対応していません | ウィンドウフォーカスは未実装 |

Claude Code または OpenAI Codex をインストールし、少なくとも一度は利用しておく必要があります。

## 初回起動

- Claude Code hook は既存の内容を保持したまま `~/.claude/settings.json` に追加されます。
- Codex の設定は変更しません。`~/.codex/sessions/YYYY/MM/DD/*.jsonl` を読み取り専用で監視します。
- 設定と利用履歴は `~/.octopus/` に保存されます。
- ログは `~/.octopus/octopus.log` に出力されます。

## ソースから起動

Git、Node.js 22（22.12.0 以降の 22.x を推奨）、Claude Code または OpenAI Codex を用意します。`.nvmrc`、Electron のインストール確認、リリースビルドは Node.js 22 を使用します。

```bash
git clone https://github.com/myunwang/LLMPET.git
cd LLMPET
npm ci
npm run install:electron
npm test
npm start
```

`npm ci` は `package-lock.json` に固定された依存関係をインストールします。`npm run install:electron` はランタイムを明示的に導入します。`npm start` は LLMPET をフォアグラウンドで実行します。`npm run test:electron` は GUI 環境でウィンドウ、IPC、権限操作、完了通知を検証します。

ランタイム保守（#31）：Electron は **44.9.3**、electron-builder は **26.18.0** に固定しています。起動ログには実際の Electron、Chromium、内蔵 Node のバージョンを記録します。2026-10-24 時点で Electron 44 は[サポート対象](https://releases.electronjs.org/)です。更新時はサポート状況を再確認し、`npm audit`（開発依存関係を含む）、`npm test`、`npm run test:electron` を実行してから各 OS のパッケージを再構築してください。`LLMPET_SMOKE_OUTPUT` を設定すると画面とバージョンを保存できます。デスクトップテストは一時データを使用します。

起動オプション：

```bash
OCTOPUS_NO_HOOKS=1 npm start  # Claude 設定を変更しない
OCTOPUS_NO_NET=1 npm start    # 任意の価格表ダウンロードを無効化
```

PowerShell：

```powershell
$env:OCTOPUS_NO_HOOKS='1'
npm start
```

Electron のダウンロードが遅い場合：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run install:electron
```

PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
npm run install:electron
```

### Electron のインストール不備・起動失敗

Windows + Node.js 26 での起動失敗は [#28](https://github.com/myunwang/LLMPET/issues/28) を参照してください。報告者は Node.js 20 への切り替えで復旧しましたが、固定済みの `@electron/rebuild` には Node.js ≥22.12.0 が必要なため、導入・パッケージ作成には 22.x を推奨します。CI は Node.js 22/24 を使用し、macOS と Windows で Electron の導入と実際のウィンドウも検証します。

Electron 33 は、インストール時に生成される `path.txt` がないと `Electron failed to install correctly` を出します。ダウンロード失敗、インストールスクリプトの無効化、`ELECTRON_SKIP_BINARY_DOWNLOAD` の設定でも起きるため、このメッセージだけでは Node.js 26 との非互換とは断定できません。

1. Node.js 22（22.12.0+）に切り替え、新しいターミナルで `node --version` を確認します。macOS/Linux の nvm では、リポジトリ内で `nvm install`、`nvm use` を実行すると `.nvmrc` が使われます。Windows では利用中の Node バージョン管理ツールで切り替えます。
2. プロジェクトディレクトリで再インストールします（`npm ci` は依存関係を作り直し、ロックファイルを保持します）。

   ```bash
   npm ci --foreground-scripts
   npm run install:electron
   npm run check:electron
   npm start
   ```

3. Electron 44 は必要時にバイナリをダウンロードするため、`npm ci` だけでは導入が完了しません。次の明示的なインストールを実行してください。通信に失敗した場合はロックファイルを削除せず再実行できます。診断は Electron のエントリーポイントを読み込まず、ダウンロードを開始しません：

   ```bash
   npm run install:electron
   npm run check:electron
   ```

4. タイムアウトや接続エラーの場合は、上記のミラー設定後に再試行し、インストールログを保存してください。

`npm start` は同じ確認を先に行い、パッケージ・インストール記録・実行ファイルがない場合に復旧手順を表示します。確認自体はダウンロード、LLMPET の起動、Agent 設定の変更を行いません。

## ローカルパッケージを作成

最初にテストします。

```bash
npm ci
npm run install:electron
npm test
```

macOS のローカル ad-hoc 署名パッケージ：

```bash
npm run package:mac:dev
```

`dist/LLMPET Dev.app` と `dist/LLMPET-<version>-mac-<arch>-dev-unsigned.zip` が生成されます。開発版は独立した `com.octopus.pet.dev` bundle id を使うため、ブランチのビルドが検証済みの `/Applications/LLMPET.app` と混同されません。正式 App を更新できるのは、ガード付きの三件套ワークフローだけです。ad-hoc 署名パッケージはローカル開発検証専用で、公開配布用ではありません。`npm run package:mac` は Apple Developer ID と公証資格情報を必須とする正式公開用の fail-closed 経路です。詳細は [macOS の署名と公証](MACOS_RELEASE.md) をご覧ください。

Windows x64：

```powershell
npm run package:win
```

NSIS インストーラーとポータブル ZIP は `dist/` に生成されます。

## アンインストール

アンインストール前に、トレイまたはソースディレクトリから Claude hook を削除します。

```bash
npm run uninstall:hooks
```

その後 LLMPET を終了します。設定、利用履歴、ログも不要な場合に限り `~/.octopus/` を削除してください。

## トラブルシューティング

- **パトロールで他のペットを動かせない：** Electron プロセスにアクセシビリティ権限を許可し、LLMPET を再起動してください。
- **セッションが表示されない：** LLMPET 起動後に Claude Code / Codex の新しいセッションを開始し、`~/.octopus/octopus.log` を確認します。
