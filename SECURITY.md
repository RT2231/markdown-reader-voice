# セキュリティポリシー

このリポジトリは「読み上げリーダー（Markdown Voice Reader）」— Markdown / PDF / EPUB を読み込んで表示・音声読み上げするクライアントサイドWebアプリと、それを支えるCloudflare Workerプロキシで構成されています。

## 対応バージョン

このプロジェクトは単一の `docs/index.html`（アプリ本体）と `worker.js`（APIプロキシ）で構成されており、バージョン番号による管理は行っていません。**常に `master` ブランチの最新版のみをサポート対象とします。**

## 脆弱性の報告方法

脆弱性を見つけた場合は、**公開のGitHub Issueは使わずに**、リポジトリオーナー（[@RT2231](https://github.com/RT2231)）へ直接ご連絡ください。GitHubの [Private vulnerability reporting](https://docs.github.com/ja/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) 機能（Security タブ → 「Report a vulnerability」）の利用を推奨します。

## 自動コードスキャン

このリポジトリでは、`master` ブランチへのpush・週次で以下のスキャンを自動実行し、結果をGitHubの Security → Code scanning タブに集約しています（`.github/workflows/` 配下）。

- **CodeQL**（GitHub公式・デフォルトセットアップ）: JavaScriptの脆弱性パターンを静的解析。リポジトリの Settings → Code security で有効化されています（GitHubの仕様上、独自のCodeQLワークフローと同時には動かせないため、カスタムYAMLではなくデフォルトセットアップ側を使用しています）
- **Microsoft Security DevOps**: ESLintセキュリティルール・既知脆弱性のある依存関係チェックなどをまとめて実行

あわせて、リポジトリの **Settings → Code security** から以下をダッシュボード操作で有効にしておくことを推奨します（コード変更不要）。

- Dependabot alerts / Dependabot security updates
- Secret scanning + Push protection

## このアプリのセキュリティ設計

### クライアントサイドアプリ（`docs/index.html`）

- 読み込んだMarkdown / PDF / EPUBの内容は、表示前に必ず [DOMPurify](https://github.com/cure53/DOMPurify) でサニタイズしています。`<script>` `<iframe>` `<object>` `<form>` などの危険なタグ、`on*` イベントハンドラ、`javascript:` スキームのURLは除去されます。
- PDFから抽出した生テキストはHTMLエスケープしてから挿入しており、テキスト中に `<` や `&` を含んでいてもHTMLとして解釈されません。
- EPUB内の画像はZIP内から取り出してBlob URLに変換し `<img>` として表示しています。`<img>` に読み込ませているだけなので、画像ファイルの中身が実際は別の形式（HTML等）であっても、スクリプトとして実行されることはありません。
- 外部リンクで `target="_blank"` が残る場合（Markdown内の生HTML経由など）、reverse tabnabbing対策として自動的に `rel="noopener noreferrer"` を付与しています。
- ElevenLabsのAPIキーはブラウザ側に一切保存されません（Worker側のシークレットとしてのみ保存）。
- 極端に大きいファイル（100MB超）の読み込みはブロックしています（タブがフリーズするのを防ぐため）。

このアプリはHTML/CSS/JSがすべて1ファイルにインライン記述されたシングルファイル構成のため、`script-src` を厳格化したContent-Security-Policyは（自分自身のスクリプトも一緒にブロックしてしまうため）導入していません。XSS対策は主にDOMPurifyによる入力サニタイズに依存しています。

### Cloudflare Worker（`worker.js`）

- ElevenLabsのAPIキーはWorker内のシークレットにのみ保存され、クライアントには一切渡されません。
- `/api/fetch-url`（URL指定でのMarkdown取得プロキシ）は、`localhost` ・プライベートIPアドレス（`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`）・リンクローカルアドレス（`169.254.0.0/16`、クラウドのメタデータエンドポイントを含む）宛のリクエストを拒否します（SSRF対策）。
  - **既知の限界**: この対策はURL中のホスト名を文字列として検査しているため、DNSリバインディング（一般ドメインが後からプライベートIPに解決される攻撃）までは防げません。Cloudflare Workersの実行環境自体がプラットフォームレベルで内部ネットワークへのアクセスを制限しているため実際の悪用可能性は低いと考えていますが、完全な保証はできません。
- すべての外部リクエストにタイムアウト（10秒）と、取得できるレスポンスサイズの上限（2MB）を設けています。
- `/api/tts` はテキスト長（最大5,000文字）、`voiceId` の形式、モデルIDのホワイトリストをサーバー側で検証しています。

### 既知の設計上のトレードオフ

- **レート制限は実装していません**（意図的な選択です）。このWorkerは全利用者が共有する公開エンドポイントとして運用されているため、Worker URLが広く知られると、想定より多くのElevenLabs API利用料が発生する可能性があります。運用者はElevenLabs側の利用量アラート・上限設定を有効にしておくことを推奨します。
- `ALLOWED_ORIGIN` はブラウザ経由のCORSリクエストを制限するだけで、curl等による直接アクセスまでは防げません。

## 依存ライブラリ

すべてCDN（jsdelivr / Google Fonts）から読み込んでいます。バージョンはコード内で明示的に固定（ピン留め）しており、`^` のような自動追従は行っていません。依存関係の更新は本リポジトリのDependabot設定（`.github/dependabot.yml`）が新しいバージョンの有無を検知し、Pull Requestとして通知します。

| ライブラリ | 用途 |
|---|---|
| marked | Markdownパース |
| DOMPurify | HTMLサニタイズ |
| highlight.js | コードシンタックスハイライト |
| KaTeX | 数式表示 |
| Mermaid | 図表表示 |
| pdf.js | PDFテキスト抽出 |
| JSZip | EPUB（ZIP）展開 |
