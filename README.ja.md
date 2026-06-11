# pbhandover

`pbhandover` は、**1 つの共有 `HANDOVER.md`**（プロジェクトの引き継ぎメモ）を **Claude Code と Codex CLI の両方** に対して自動で最新に保つ、単一の npm CLI です。各エージェントの **Stop フック** を利用して動作し、**ノンブロッキング** です。ターンが終わると、フックはごく小さなジョブをキューに入れてすぐに戻ります。その後、デタッチされたバックグラウンドワーカーが（ヘッドレスモードの）エージェントに直近ターンの要約を依頼し、`HANDOVER.md` を更新します。エージェントは引き継ぎ更新を待ちません。

English version: [README.md](README.md)

- リポジトリ: <https://github.com/pbtechlab/pbhandover>
- ライセンス: MIT

---

## 目次

- [解決する課題](#解決する課題)
- [特長](#特長)
- [動作要件](#動作要件)
- [インストール](#インストール)
- [クイックスタート](#クイックスタート)
- [日常利用: セッション内での `@handover`](#日常利用-セッション内での-handover)
- [コマンドリファレンス](#コマンドリファレンス)
- [仕組み（アーキテクチャ）](#仕組みアーキテクチャ)
  - [2 つのファイルレベル](#2-つのファイルレベル)
  - [`.pbhandover/` プロジェクト構成](#pbhandover-プロジェクト構成)
  - [全体フロー](#全体フロー)
  - [発火エージェント別の要約](#発火エージェント別の要約)
  - [再帰の防止](#再帰の防止)
  - [シークレットの墨消し](#シークレットの墨消し)
  - [テンプレート・プロンプトのコピーフロー](#テンプレートプロンプトのコピーフロー)
- [設定](#設定)
- [環境変数](#環境変数)
- [エージェント連携の詳細](#エージェント連携の詳細)
- [アンインストール](#アンインストール)
- [FAQ・トラブルシューティング](#faqトラブルシューティング)
- [開発](#開発)
- [プライバシーと Git](#プライバシーと-git)

---

## 解決する課題

エージェントのセッションが長くなると、次のターン・次のエージェント・次の人間には、短く最新の引き継ぎメモが必要になります。プロジェクトの目的、いま何をしているか、実行したコマンド、成功したこと、失敗したこと、疑っている原因、試した対処、次にやること、触ってはいけないもの。

`pbhandover` はそのメモを自動化し、エージェント間で共有します。

- エージェントがターンを終え、`Stop` イベントが発火する。
- Stop フックは 1 件のジョブをキューに書き込み、すぐに戻る（ノンブロッキング）。
- デタッチされたバックグラウンドワーカーが、キュー内のジョブを 1 件ずつ処理する。
- 各ジョブについて、ワーカーは **そのターンを生成したのと同じエージェント** をヘッドレスモードで実行し、テンプレートに従って唯一の共有 `HANDOVER.md` を更新する。
- `HANDOVER.md` は共有なので、直前のターンが Claude Code でも Codex でも、引き継ぎはシームレスに続きます。

生成される引き継ぎファイルは既定でローカル扱いです。マシン固有の情報を含み得るため、明示的にオプトインしない限り Git から除外されます。

## 特長

- **プロジェクトごとに 1 つの共有状態ディレクトリ** — `.pbhandover/` に設定・テンプレート・プロンプト・キュー・ログ・ワーカーロックをまとめます。
- **1 つの共有 `HANDOVER.md`** — プロジェクトルートに置かれ、両方のエージェントが読み書きします。
- **発火エージェント別の要約** — 各 Stop フックは、どのエージェントが発火したかをジョブにタグ付けします（`--agent claude` / `--agent codex`）。ワーカーは **同じ** エージェントで要約します（Claude のターンは Claude、Codex のターンは Codex）。モデルはエージェントごとに設定可能です。
- **セッション内での操作** — Claude Code / Codex のセッション内で `@handover on|off|status|flush`（および `setup`/`doctor`）を直接入力できます。Claude Code はネイティブの `/handover` スラッシュコマンドにも対応します。
- **ノンブロッキング** — Stop フックはキューに入れるだけ。ワーカーはバックグラウンドでデタッチ実行されます。
- **再帰安全** — ワーカー自身のエージェント実行が、引き継ぎの無限ループを引き起こさないようガードします。
- **シークレットの墨消し** — API キー、トークン、シークレット、パスワード、`Bearer` トークン、`sk-...` キーを、キューのペイロード・トランスクリプト・取得した出力から除去します。

## 動作要件

- Node.js **18 以上**
- npm
- 使いたいエージェント:
  - **Claude Code** CLI（`PATH` 上に `claude`）— Claude 連携用
  - **Codex CLI**（`PATH` 上に `codex`）— Codex 連携用
- Windows / macOS / Linux

両方のエージェントは必須ではありません。`pbhandover on` は存在するエージェントを自動検出し、該当するものだけを有効化します。

Windows では PowerShell またはコマンドプロンプトで実行してください。macOS/Linux ではターミナル、bash、zsh などを使います。

## インストール

npm レジストリからグローバルインストールします。

```sh
npm install -g pbhandover
```

パッケージの `postinstall` スクリプトがベストエフォートで `pbhandover setup --quiet` を実行します（インストール自体は失敗しません）。`setup` は共有ユーザーのテンプレート/プロンプト/設定を作成し、マシン上で利用可能なすべてのエージェントに対して `@handover` コマンドルーターをインストールします。

グローバルインストールは、すべてのプロジェクトで引き継ぎ生成を自動有効化はしません。各プロジェクトで個別に `pbhandover on`（またはセッション内の `@handover on`）を実行して有効化します。

## クイックスタート

1. ターミナルを開き、`HANDOVER.md` を保守したいプロジェクトへ `cd` します。
2. プロジェクトで引き継ぎを有効化します。

   ```sh
   pbhandover on
   ```

   エージェントフラグなしの場合は **自動検出** されます。プロジェクトディレクトリ（`.claude` / `.codex`）が存在するか、CLI がインストールされているエージェントをすべて有効化します。いずれも検出されない場合は、既知の全エージェントを有効化するフォールバックになります。

3. 設定を確認します。

   ```sh
   pbhandover status
   ```

4. Claude Code や Codex で普段どおり作業します。エージェントがターンを終えるたびに、Stop フックが引き継ぎ更新をキューに入れ、バックグラウンドワーカーが `HANDOVER.md` を更新します。
5. プロジェクトを閉じる前や引き継ぐ前に、保留中のジョブを処理しきります。

   ```sh
   pbhandover flush
   ```

これらはすべてエージェントのセッション内からも実行できます（下記参照）。

## 日常利用: セッション内での `@handover`

これが最も主要な日常の操作方法です。**Claude Code** または **Codex** のセッション内で次を入力します。

```text
@handover on
@handover off
@handover status
@handover flush
```

`@handover setup` と `@handover doctor` も使えます（`doctor` は `status` の別名）。

仕組み: `UserPromptSubmit` ルーターが `@handover` で始まるプロンプト（`/handover`、`handover`、`pbhandover` も対象）を横取りし、対応する CLI サブコマンドをプロジェクト内でローカル実行して、その結果をセッションに返します。**通常のプロンプトとしてモデルには送られません。**

- **Claude Code** では、ルーターは `block` 判定で応答するため、`@handover ...` はモデルのトークンを消費しません。さらに Claude Code はネイティブの **`/handover`** スラッシュコマンド（`/handover on`、`/handover status` など）にも対応し、これは同じ CLI を Bash ツール経由で実行します。
- **Codex** では、ルーターがコマンドをローカル実行し、その結果を追加コンテキストとして注入して、通常のリクエストとして扱わず結果を報告するよう Codex に促します。

ルーティングされるのは次の固定セットのみです: `on`、`off`、`status`、`doctor`、`flush`、`setup`。それ以外は通常どおりモデルに渡されます。

## コマンドリファレンス

| コマンド | 説明 |
| --- | --- |
| `pbhandover setup [--force] [--no-router]` | 共有ユーザーの `template.md` / `prompt.md` / `config.json` を作成し、利用可能な全エージェントに `@handover` コマンドルーター（+ `/handover` スラッシュコマンド）をインストールします。`--force` は共有テンプレート/プロンプトをパッケージ既定で上書き。`--no-router` はルーター導入をスキップ。 |
| `pbhandover on [--claude] [--codex] [--track-handover] [--track-hooks] [--force-template]` | 現在のプロジェクトで Stop フックを有効化します。エージェントフラグなし → **自動検出**（[クイックスタート](#クイックスタート)参照）。`.pbhandover/`、プロジェクトのテンプレート/プロンプト/設定、`HANDOVER.md`、選択した各エージェントの Stop フックを作成し、`.gitignore` を更新します。 |
| `pbhandover off [--claude] [--codex]` | 現在のプロジェクトで本ツールの Stop フックを無効化します。フラグなし → 現在構成済みの全エージェント。`HANDOVER.md` と `.pbhandover/` はそのまま残します。 |
| `pbhandover status`（別名 `doctor`） | 全体の ON/OFF、引き継ぎ/テンプレートのパス、キュー件数（pending/done/failed）、各エージェントの `enabled` / `model` / `available` / フックファイル状況を表示します。 |
| `pbhandover router install\|uninstall\|status [--claude] [--codex]` | `@handover` の `UserPromptSubmit` ルーターと `/handover` スラッシュコマンドを管理します。install/uninstall はフラグなしで利用可能エージェント対象。`status` は常に全エージェントを報告。 |
| `pbhandover trust` | インストール済みの Codex フックを信頼します（`~/.codex/config.toml` に `[hooks.state.*]` を書き込み）。 |
| `pbhandover enqueue --agent claude\|codex` | **内部用** の Stop フックエントリポイント。1 件のジョブを書き込みワーカーを起動して戻ります。通常は手動実行しません。 |
| `pbhandover worker` | **内部用。** キュー内のジョブをバックグラウンドで順次処理します。 |
| `pbhandover flush` | キュー内のジョブをフォアグラウンドで処理し、空になるまで待機します。 |
| `pbhandover template path\|sync [--force]` | `path` は共有/プロジェクトのテンプレートパスを表示。`sync` は共有テンプレートからプロジェクトテンプレートを作成（`--force` で上書き）。 |
| `pbhandover --help` / `-h` | 使い方を表示。 |
| `pbhandover --version` / `-V` | バージョンを表示。 |

### `on` のオプション

- `--claude` / `--codex` — 指定したエージェントのみ有効化。どちらも指定しない場合は自動検出。
- `--track-handover` — `HANDOVER.md` を `.gitignore` に追加しない（既定では無視されます）。
- `--track-hooks` — エージェントのフックファイルを `.gitignore` に追加しない。
- `--force-template` — 共有ユーザーのコピーから、プロジェクトのテンプレートとプロンプトを上書きします。

## 仕組み（アーキテクチャ）

### 2 つのファイルレベル

**ユーザーレベル（マシン上の全プロジェクトで共有）** — `setup` で作成:

- 共有ディレクトリ: `~/.pbhandover/`（Windows: `%USERPROFILE%\.pbhandover\`）
  - `template.md` — 新規プロジェクト向けの既定の引き継ぎ構造
  - `prompt.md` — 既定のワーカー記述ポリシー
  - `config.json` — 既定のキューモード、引き継ぎファイル名、墨消しフラグ、エージェント別の既定モデル
  - `prompt-router.log` — ルーティングされた `@handover` コマンドのログ
- Claude ユーザー設定: `~/.claude/settings.json`（ルーターフック）— 基底ディレクトリは `CLAUDE_CONFIG_DIR` で変更可
- Claude スラッシュコマンド: `~/.claude/commands/handover.md`
- Codex ユーザーフック: `~/.codex/hooks.json`（ルーターフック）— 基底ディレクトリは `CODEX_HOME` で変更可

**プロジェクトレベル（`on` で現在のプロジェクトに作成）**:

- `.pbhandover/` — 共有のエージェント中立な状態ディレクトリ（下記構成参照）
- `.claude/settings.local.json` — Claude の Stop フックエントリ（Claude 有効時）
- `.codex/hooks.json` — Codex の Stop フックエントリ（Codex 有効時）
- `HANDOVER.md` — プロジェクトルートの共有引き継ぎメモ

ユーザーレベルのテンプレートが起点です。各プロジェクトは自身のコピーを持つため、あるプロジェクトのテンプレートを編集しても他には影響しません。

### `.pbhandover/` プロジェクト構成

```text
your-project/
  HANDOVER.md                       # 共有引き継ぎメモ（プロジェクトルート）
  .claude/
    settings.local.json             # Claude の Stop フック（個人用・既定で git 無視）
  .codex/
    hooks.json                      # Codex の Stop フック（既定で git 無視）
  .pbhandover/
    config.json                     # プロジェクト設定（enabled、agents、model、トラッキングフラグ）
    template.md                     # プロジェクト固有の引き継ぎ構造
    prompt.md                       # プロジェクト固有のワーカー記述ポリシー
    queue/                          # 保留ジョブ（キューしたターン 1 件につき JSON 1 つ）
    done/                           # 完了ジョブの記録
    failed/                         # 失敗ジョブの記録（調査用）
    worker.log                      # バックグラウンドワーカーのログ
    worker.lock                     # 単一ワーカーロック（30 分でステール扱い）
    last-prompt.md                  # 要約に送った最後のプロンプト
    last-claude-message.txt         # Claude から取得した最後のメッセージ
    last-codex-message.txt          # Codex から取得した最後のメッセージ
```

> 補足: `last-prompt.md`、`last-claude-message.txt`、`last-codex-message.txt` はワーカーがジョブを処理する際に書き込むため、引き継ぎ更新が一度実行されてから現れます。

### 全体フロー

```text
  エージェントがターンを終える（Claude Code または Codex）
            │
            ▼
  Stop フック発火 ──► pbhandover enqueue --agent <claude|codex>
            │            ・再帰ガードを確認（下記）
            │            ・.pbhandover/queue/ にジョブを 1 件書き込む
            │            ・デタッチされたバックグラウンドワーカーを起動
            ▼            ・すぐに戻る（ノンブロッキング）
  エージェントは継続可能 — 待たない

  ── 一方、バックグラウンドでは ────────────────────────────────

  pbhandover worker
            │  ・単一の worker.lock を取得
            │  ・キュー内のジョブを古い順に処理:
            ▼
     buildPrompt(): プロンプト規則 + テンプレート + 既存 HANDOVER.md
                    + 墨消し済みジョブ + 墨消し済みトランスクリプト末尾
            │
            ▼
     runSummarizer(): フックを発火したのと同じエージェントで実行
       ・claude: claude -p --model <model> --output-format text
       ・codex:  codex exec --model <model> --output-last-message ...
       （ワーカーは PBHANDOVER_WORKER=1 を設定するため、要約に使う
         エージェントの Stop フックは何もしない — これで再帰を断つ）
            │
            ▼
     エージェントが HANDOVER.md をその場で編集（stdout ではなくディスクへ）
            │
            ▼
     成功 → ジョブを done/ へ      失敗 → ジョブを failed/ へ
            │
            ▼
     キューが空になるまで繰り返し、最後にロックを解放
```

### 発火エージェント別の要約

各 Stop フックは、発火したエージェントをジョブにタグ付けします（`--agent claude` または `--agent codex`）。ワーカーがジョブを処理する際は、**同じ** エージェントでそのターンを要約するため、作業を生み出したモデルが引き継ぎも書きます。

| エージェント | 既定の要約モデル | ヘッドレス実行 |
| --- | --- | --- |
| Claude Code | `claude-haiku-4-5-20251001` | `claude -p --model <model> --dangerously-skip-permissions --output-format text`（要約は stdout から取得） |
| Codex CLI | `gpt-5.3-codex-spark` | `codex --disable hooks --model <model> --sandbox workspace-write --ask-for-approval never exec --skip-git-repo-check --output-last-message <file> -` |

モデルは `.pbhandover/config.json` でエージェントごとに設定できます（[設定](#設定)参照）。

### 再帰の防止

ワーカーはエージェントをヘッドレスモードで起動しますが、そのエージェントは終了時に **自身の** Stop フックを発火し、別の引き継ぎジョブを無限にキューしうる構造になっています。これを 2 つのガードで防ぎます。

1. ワーカーは環境変数 `PBHANDOVER_WORKER=1` を設定します。`enqueue` はこれを検出すると即座に戻るため、要約用エージェントの Stop フックは何もしません。
2. `enqueue` は、エージェントのフックペイロードに `stop_hook_active: true` が含まれる場合も即座に戻ります（エージェントは再入の Stop イベントにこの印を付けます）。

### シークレットの墨消し

キューへの書き込み・プロンプトでの利用・ディスクへの取得の前に、テキストは墨消しフィルターを通り、次をマスクします。

- `api_key` / `api-key` / `apikey`、`token`、`secret`、`password` / `passwd`、`authorization` の値 → `[REDACTED]`
- `sk-...` 形式のキー（20 文字以上）→ `sk-[REDACTED]`
- `Bearer <token>` → `Bearer [REDACTED]`

墨消しは、キューのペイロード、トランスクリプト末尾、要約に渡す既存 `HANDOVER.md` の抜粋、取得した stdout/stderr に適用されます。これは保険であって保証ではありません。共有前に生成ファイルを必ず確認してください。

### テンプレート・プロンプトのコピーフロー

```text
1. パッケージ既定: templates/default-template.md   prompts/default-prompt.md
2. ユーザー共有  : ~/.pbhandover/template.md         ~/.pbhandover/prompt.md     （setup が作成）
3. プロジェクト  : .pbhandover/template.md           .pbhandover/prompt.md       （on がコピー）
4. プロジェクトのテンプレートから HANDOVER.md を作成
```

ワーカーはプロンプト構築時に、優先順に「プロジェクトのテンプレート → バンドルされた既定」を読み込みます。テンプレートはジョブごとに読まれるため、`.pbhandover/template.md` を編集すると次回の引き継ぎ更新に反映されます。特定プロジェクトで別形式が必要ならプロジェクトのテンプレートを、今後のプロジェクトの既定を変えたいならユーザー共有テンプレートを編集してください。

既定のテンプレートは日本語で、10 セクション（プロジェクトの目的／現在の作業・タスク／実行したコマンド／成功・完了タスク／失敗・エラー／疑っている原因／試した対処／次にやること・積まれているタスク／注意点／その他重要な特記事項）に加え、「最終更新」行と、どのエージェント（claude / codex）が更新したかを記録する「エージェント」欄を持ちます。

## 設定

### 共有ユーザー設定 — `~/.pbhandover/config.json`

`setup` で作成:

```json
{
  "queueMode": "sequential",
  "handoverFile": "HANDOVER.md",
  "redactSecrets": true,
  "agents": {
    "claude": { "enabled": false, "model": "claude-haiku-4-5-20251001" },
    "codex":  { "enabled": false, "model": "gpt-5.3-codex-spark" }
  }
}
```

### プロジェクト設定 — `.pbhandover/config.json`

`on` で作成・更新:

```json
{
  "enabled": true,
  "trackHandover": false,
  "trackHooks": false,
  "queueMode": "sequential",
  "handoverFile": "HANDOVER.md",
  "templateFile": ".pbhandover/template.md",
  "promptFile": ".pbhandover/prompt.md",
  "agents": {
    "claude": { "enabled": true, "model": "claude-haiku-4-5-20251001" },
    "codex":  { "enabled": true, "model": "gpt-5.3-codex-spark" }
  }
}
```

- `enabled` — プロジェクトで引き継ぎが有効かどうか（いずれかのエージェントが有効なら true）。
- `agents.<name>.enabled` — エージェントごとの ON/OFF。
- `agents.<name>.model` — そのエージェントのターンを要約するモデル。エージェントが受け付ける任意のモデル ID/エイリアスに変更できます。
- `trackHandover` / `trackHooks` — `HANDOVER.md` とフックファイルを `.gitignore` から除外しないか。
- `workerTimeoutMs`（任意）— ジョブ単位の要約タイムアウト（ミリ秒）。未設定時は `600000`（10 分）。

## 環境変数

| 変数 | 効果 |
| --- | --- |
| `PBHANDOVER_WORKER=1` | ワーカーが要約実行の前後で設定します。これがあると `enqueue` は何もしません。主要な再帰ガードであり、通常は手動で設定しません。 |
| `PBHANDOVER_NO_WORKER=1` | `enqueue` はジョブを書き込みますが、バックグラウンドワーカーを **起動しません**。テスト用や、`flush` でワーカー実行を手動制御したい場合に便利です。 |
| `PBHANDOVER_CLAUDE_BIN` | 要約に使う `claude` バイナリを上書きします。 |
| `PBHANDOVER_CODEX_BIN` | 要約に使う `codex` バイナリを上書きします。 |
| `CLAUDE_CONFIG_DIR` | Claude のホームディレクトリ（既定 `~/.claude`）を上書き。ルーターフックとスラッシュコマンドのインストール先に影響します。 |
| `CODEX_HOME` | Codex のホームディレクトリ（既定 `~/.codex`）を上書き。ルーターフックと `config.toml` の信頼エントリの書き込み先に影響します。 |

## エージェント連携の詳細

### Claude Code

- **プロジェクト Stop フック** — `.claude/settings.local.json` の `hooks.Stop` に追加され、`... enqueue --agent claude` を実行します。
- **ユーザールーター** — `~/.claude/settings.json` の `hooks.UserPromptSubmit` エントリで `... prompt-router --agent claude` を実行します。
- **スラッシュコマンド** — `~/.claude/commands/handover.md` がインストールされ、`/handover ...` がネイティブに動作します。

### Codex CLI

- **プロジェクト Stop フック** — `.codex/hooks.json` の `hooks.Stop` に追加され、`... enqueue --agent codex` を実行します。
- **ユーザールーター** — `~/.codex/hooks.json` の `hooks.UserPromptSubmit` エントリで `... prompt-router --agent codex` を実行します。
- **フックの信頼** — Codex はフックの信頼を要求します。`on` は pbhandover のフックを自動的に信頼し（`postEnable`）、いつでも `pbhandover trust` で再実行できます。信頼は、Codex の `app-server` にインストール済みフックを問い合わせ、`~/.codex/config.toml` に `[hooks.state.<key>]` ブロック（`trusted_hash` と `enabled = true`）を書き込むことで行われます。パッケージの再インストール・移動や、生成済みフックコマンドの編集後は `trust` を再実行してください。

## アンインストール

### 1 プロジェクトを無効化

```sh
cd path/to/your/project
pbhandover off
```

本ツールの Stop フックエントリを削除しますが、`.pbhandover/` と `HANDOVER.md` は調査用に残します。

### ローカルのプロジェクトファイルを削除

不要だと確認したら、`HANDOVER.md` と `.pbhandover/` を削除し、`.claude/settings.local.json` や `.codex/hooks.json` から pbhandover の Stop エントリを削除します（他に使っている設定がない場合のみファイルごと削除）。

### ユーザーレベルのルーターとスラッシュコマンドを削除

```sh
pbhandover router uninstall
```

### グローバル npm パッケージを削除

```sh
npm uninstall -g pbhandover
```

### 任意: ユーザーレベルのクリーンアップ

アンインストール後、不要であれば共有ディレクトリを削除します。

- Windows: `%USERPROFILE%\.pbhandover`
- macOS/Linux: `~/.pbhandover`

## FAQ・トラブルシューティング

**`pbhandover` が見つからない。** npm のグローバル bin が `PATH` にあるか確認し（`npm bin -g` / `npm config get prefix`）、ターミナルを再起動してください。

**`@handover on` が通常のプロンプトとして扱われる。** `pbhandover router install` でルーターを導入/更新し（Codex の場合は `pbhandover trust` も）、そのプロジェクトでエージェントを再起動してください。

**`HANDOVER.md` が更新されない。** `pbhandover status` でキュー件数を確認し、`pbhandover flush` で保留ジョブをフォアグラウンド処理してください。`.pbhandover/worker.log` と `.pbhandover/failed/` でエラーを調査します。

**引き継ぎ更新が一度も走らない（キューが pending のまま）。** デタッチされたワーカーの起動に失敗している可能性があります。`.pbhandover/worker.log` を確認してください。`pbhandover flush` でいつでも手動処理できます。意図的に `PBHANDOVER_NO_WORKER=1` を設定している場合、ジョブは `flush`/`worker` でのみ実行されます。

**テンプレートを変えたのに古いまま。** `pbhandover flush` を実行してください。ワーカーはジョブごとにプロジェクトテンプレートを読むため、次に処理されるジョブで新形式が使われます。

**「A worker is already running.」と出る。** ワーカーは `.pbhandover/worker.lock` で 1 つだけ動作します。30 分より古いステールなロックは自動的に回収されます。必要なら、ワーカーが動いていないことを確認のうえ `worker.lock` を手動削除してください。

**Codex がフックを未信頼と言う。** `pbhandover trust` を実行し（Codex を再起動）。`~/.codex/config.toml` の `[hooks.state.*]` 信頼エントリを書き直します。

**どのエージェントがどのターンを要約する？** そのターンを生成したのと同じエージェントです。Claude のターンは Claude、Codex のターンは Codex が、それぞれ設定されたモデルで要約します。

## 開発

```sh
npm install
npm test          # node --test
npm run smoke     # pbhandover --help
node bin/pbhandover.js --help
```

## プライバシーと Git

既定では、`on` は次を `.gitignore` に追加します。

```gitignore
/HANDOVER.md
.pbhandover/
.claude/settings.local.json   # Claude 有効時
.codex/hooks.json             # Codex 有効時
```

`HANDOVER.md` は先頭の `/` でアンカーされ、リポジトリルートのファイルだけに一致します（大文字小文字を区別しないファイルシステムで重要）。これらをトラッキングしたい場合は `--track-handover` / `--track-hooks` を使ってください。

引き継ぎファイル・キューファイル・プロンプト・テンプレート・ログにシークレットを残さないでください。API キー、トークン、パスワード、`.env` の内容、秘密鍵、内部サーバー名、個人・顧客データなどです。ペイロード・トランスクリプト末尾・取得出力は墨消しフィルターを通りますが、リポジトリ・再現手順・サポートバンドルを共有する前に、生成ファイルを必ず確認してください。
