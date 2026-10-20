# LLMPET をローカル環境へ導入する

このガイドでは、ソースからの起動・テストと、ローカル開発検証用パッケージの作成を説明します。

## 対応環境

| プラットフォーム | ソースから起動 | 備考 |
| --- | --- | --- |
| macOS Apple Silicon | 対応 | パトロールモードは macOS のみ |
| Windows x64 | 対応 | 一般的なターミナルのセッションフォーカスに対応 |
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
npm test
npm start
```

`npm ci` は `package-lock.json` に固定された依存関係をインストールします。`npm start` は LLMPET をフォアグラウンドで実行します。

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
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci
```

PowerShell：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci
```

### Electron のインストール不備・起動失敗

Windows + Node.js 26 での起動失敗は [#28](https://github.com/myunwang/LLMPET/issues/28) を参照してください。報告者は Node.js 20 への切り替えで復旧しましたが、固定済みの `@electron/rebuild` には Node.js ≥22.12.0 が必要なため、導入・パッケージ作成には 22.x を推奨します。旧バージョンでのヘッドレステストは、Electron のダウンロード・起動・パッケージ作成まで検証するものではありません。

Electron 33 は、インストール時に生成される `path.txt` がないと `Electron failed to install correctly` を出します。ダウンロード失敗、インストールスクリプトの無効化、`ELECTRON_SKIP_BINARY_DOWNLOAD` の設定でも起きるため、このメッセージだけでは Node.js 26 との非互換とは断定できません。

1. Node.js 22（22.12.0+）に切り替え、新しいターミナルで `node --version` を確認します。macOS/Linux の nvm では、リポジトリ内で `nvm install`、`nvm use` を実行すると `.nvmrc` が使われます。Windows では利用中の Node バージョン管理ツールで切り替えます。
2. プロジェクトディレクトリで再インストールします（`npm ci` は依存関係を作り直し、ロックファイルを保持します）。

   ```bash
   npm ci --foreground-scripts
   npm run check:electron
   npm start
   ```

3. まだ失敗する場合は `npm config get ignore-scripts` が `true` か、`ELECTRON_SKIP_BINARY_DOWNLOAD` が設定されているかを確認します。`--foreground-scripts` はログを表示するだけで、これらの設定を上書きしません。ダウンロードする場合はスキップ用環境変数を解除します。パッケージが存在する場合は、固定されたバージョンのインストーラーだけを再実行できます。

   ```bash
   node node_modules/electron/install.js
   npm run check:electron
   ```

4. タイムアウトや接続エラーの場合は、上記のミラー設定後に再試行し、インストールログを保存してください。

`npm start` は同じ確認を先に行い、パッケージ・インストール記録・実行ファイルがない場合に復旧手順を表示します。確認自体はダウンロード、LLMPET の起動、Agent 設定の変更を行いません。

## ローカルパッケージを作成

最初にテストします。

```bash
npm ci
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
