# CLAUDE.md

高校サッカー監督シミュレーション。設計書は claude.ai の Project「高校サッカー監督」
（claude/設計書.md・データ設計.md・技術構成.md・顔の設計.md・試合エンジンの合格ライン.md・戦術理論とエンジンの対応.md・戦術実装の記録.md）。実装は設計書の「開発順序」の段階ごとに進める。

## ユーザー（SHO）
- 会話は日本語。トークンは節約。手作業で済むことは依頼する。
- PCのPowerShellは古い（5.x）。コマンドは `;` 区切り（`&&` は使えない）。VMは使えない。
- 設計の判断は選択肢を出して決めてもらう。細かいデータ構造の羅列は読まない。

## 構成
engine/（試合エンジン・純粋JS）/ sim/（週進行など）/ data/ / ui/ / render/ / tools/。
ビルドなし・素のESモジュール。Preact+htm・Three.js は同梱予定。デプロイは GitHub → Vercel。

## engine/ の決まり
- Math の sin/cos/tan/atan/atan2/exp/log/pow/hypot/random、`**`、Date、performance は禁止。
  `engine/core/math.js` の関数を使う。`npm test` の lint が検査する。
- 乱数は `hash4(種, tick, 選手, 用途)`。状態を持たせない。
- 試合の状態は `F`・`N`・`log` だけ（AIの内部状態も）。`snapshot`/`restore` で完全に戻せること。
- 結果が変わる修正は `ENGINE_VERSION` を上げ、`npm run golden` で基準値を更新する。
- チーム指示（`data/tactics.js` の13項目、-1〜+1、0=標準）は `engine/tactic.js` で数値にして `m.tac[k]` から読む。指示を足すときは、0 のとき従来と同じ動きにする（golden が変わらないこと）。その場合 `ENGINE_VERSION` は上げない。
- engine/ から render/・ui/・tools/・sim/ を import しない。

## テスト
`npm test`（決定性・保存/復元・基準値・lint）。`node tools/batch.js --n 50 --check` で一括実行。
