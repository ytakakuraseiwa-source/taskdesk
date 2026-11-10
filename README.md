# Taskdesk

PC ファーストのタスク管理アプリ。起動直後からメモを入力でき、Enter で未着手タスクに追加します。Shift + Enter は改行、`/` はメモ欄に移動します。タスクをクリックすると未着手 → 進行中 → 完了 → 未着手の順に切り替わります。

ゲストのタスクはブラウザに保存します。Google でログインすると、そのブラウザで入力したゲストのタスクをアカウントに取り込み、D1 と同期します。ログイン中の書き込みが一時的に失敗した場合は端末に保留し、接続復帰時やタブを表示したときに再試行します。同じタスクを複数端末で変更した場合は更新時刻が新しい変更を採用します。AI へは「AIで分解」を押した時点のメモだけを送信し、提案のうち選択した項目だけを追加できます。

## 技術選定

| 技術 | 選定理由 |
| --- | --- |
| HTML、CSS、ブラウザ標準 JavaScript | ビルド済みの大きな実行環境の読み込みを省き、HTML の autofocus と通常のフォームで入力欄を先に使えるようにする。 |
| CSS グラデーション、backdrop-filter、アニメーション | 白い半透明のパネル、光のにじみ、カードの移動先への登場、全画面シマーとフェードを追加のライブラリなしで表現する。モーション軽減設定も尊重する。 |
| localStorage / sessionStorage | 通信を待たずにタスクを保存し、タブ内の入力途中のメモを再読み込み後に復元する。アカウントごとにタスクの端末キャッシュを分ける。 |
| Cloudflare Workers と Static Assets | 同一オリジンで静的画面と API を配信し、Cloudflare 上で OAuth のコールバックを処理する。 |
| Cloudflare D1 と SQL | セッション、タスク、AI 使用回数を永続化する。ユーザー ID で検索と更新を限定し、まとめて更新する際は D1 のバッチを使う。 |
| Workers AI / Gemma 4 26B A4B | Workers のバインディングからメモの分解を実行し、日本語の提案を返す。選択 UI に渡す前に形式を検証する。 |
| Google OAuth 2.0 / OpenID Connect | Google の本人識別子でアカウントを管理する。認可コード、state、PKCE を使い、アプリのセッションは HttpOnly Cookie と D1 に保存したトークンハッシュで管理する。 |
| Node.js 24 と組み込み SQLite | ローカルでも同じ Worker と SQL を動かし、Cloudflare や Google のアカウントなしで開発できる。 |
| Playwright と実 Chrome | フォーカス、キー入力、画面遷移、Cookie、再読み込みを実ブラウザ上で検証する。 |
| Git / GitHub、npm ロックファイル、Wrangler | 公開するソースの履歴、再現可能な開発依存関係、Cloudflare の設定・マイグレーション・公開コマンドを管理する。 |

## ローカル起動と検証

Node.js 24、npm、Chrome が必要です。Chrome の場所を明示する場合は `CHROME_PATH` を設定します。

```sh
npm ci
npm run dev
npm run test:e2e
```

`npm run dev` は既定で [localhost:8787](http://localhost:8787) を起動します。E2E は Chrome から実際に操作し、Worker とローカル SQLite を使います。Google の外部エンドポイントと Workers AI の応答はテスト用の代替です。本番のログインと AI 推論は、デプロイ後に実アカウントで確認します。

## Cloudflare へ公開

1. `npx wrangler login` で公開先アカウントを接続します。
2. `npx wrangler d1 create taskdesk` で D1 を作成し、出力の ID を `wrangler.jsonc` の `database_id` に設定します。
3. `npx wrangler d1 migrations apply taskdesk --remote` を実行し、`npx wrangler deploy` で公開 URL を確認します。
4. Google Cloud でウェブアプリケーションの OAuth クライアントを作成し、承認済みリダイレクト URI に `https://公開先/auth/callback` を追加します。アプリをテストモードで運用する場合は、ログインに使う Google アカウントをテストユーザーに追加します。
5. `npx wrangler secret put GOOGLE_CLIENT_ID` と `npx wrangler secret put GOOGLE_CLIENT_SECRET` を実行します。値は Wrangler の入力欄へ直接入力してください。カスタムドメインなどで URL を固定する場合は `APP_ORIGIN` にスキームとホストを指定します。
6. 公開 URL を Chrome で開き、ゲストのメモ追加 → Google ログイン → 同期 → AI の提案追加を確認します。別のブラウザプロファイルから同期結果を確認し、ログアウト後にタスクが表示されないことも確認します。

公式資料

- [Cloudflare Workers AI のバインディング](https://developers.cloudflare.com/workers-ai/get-started/workers-wrangler/)
- [Gemma 4 26B A4B のモデル仕様](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
