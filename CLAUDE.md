# CLAUDE.md

高校サッカー監督シミュレーション。設計書は claude.ai の Project「高校サッカー監督」
（claude/設計書.md・データ設計.md・技術構成.md・顔の設計.md・試合エンジンの合格ライン.md・戦術理論とエンジンの対応.md・戦術実装の記録.md・戦術実装の記録_続き.md・認知層の記録.md・エンジンの現在地と課題.md・エンジンレビュー_2026-11-13.md・エンジンレビュー_検証結果_2026-11-13.md）。実装は設計書の「開発順序」の段階ごとに進める。

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
- 能力の効き（v15）: エンジンが使うのは能力そのものではなく実効値 `effVec`（`engine/abil.js`。基準値 + `AB_G`(0.26)×(能力−基準値)）。`setPlayerAb` で1回だけ掛ける。基準値は外野手の能力が 10、GK 専用の5能力は標準のGK（`GK_ANCHOR`）。全能力が一律に差1・3・5 違うと勝ち点率が約 61・85・93%（目標は現実のElo・1点≒90Eloの仮定で 63・83・93%。得点比の対数 0.30・1.30・1.90）。能力の差を使う試験・計測は `effVec`（`abVec` は生の値）。1人だけ・一部の能力だけの効きも同じ比で小さい（役割ごとの能力のコントラストも約1/4）。
- パスの見込み（decide.js）: 受け手のファーストタッチは、決めた時の圧力 pd ではなく到着時の圧力 `PA0 + PA1×pd`（0.5 + 0.52pd）で見積もる（実測: パスの飛行中に相手が寄る・見えていない相手がいる）。
- 体力は `F[F_STA+選手]`（1=万全）。能力から決まる本来の最高速度・加速度は `m.vmax0`/`m.acc0`、`m.vmax`/`m.acc` は疲れを反映した値（`engine/stamina.js` の `fatigue` が毎tick作り直す）。能力を差し替えるときは vmax0/acc0 側を変える。
- 組み立て（`build`。-1 つなぐ〜+1 蹴る）は decide.js のパス・クリアの価値に効く（`atkParams` の `longPen/longBon/shortB/backB/clrK/clrLoss/gkFx/reliefK`。0 で従来と同じ）。型（標準・保持・直接）は `data/styles.js`、型ごとの狙いの数字と測定は `tools/style.js`（`npm run style`。90分×48試合×3種で約5分。型を変えたら外れた項目が無いか見る）。
- 後ろからつなぐ陣形・擬似カウンター（v16）: 組み立て `build`<0 のときだけ効く（`atkParams` の `bsK`=-build、`lureK`=-build×(0.5+0.5×risk)。新しい指示は足していない。build≥0 は従来と同じ）。陣形（brain.js の `BS_*`・`bsW`）: ボール（ならした位置）が自陣 -17.5m より後ろで最大・+8m で 0 の度合いで、GKが +4m 前へ（`planGK`）、CBの持ち場の横が ×1.5（上限 14.5m）、守備的MF（D。いなければ陣形が最も深い M）が自陣ゴールラインから 25m まで降りる（横はボール側へ 0.25）。擬似カウンター（decide.js の `lureOf`）: 相手の最終ライン（`offsideLine`）が 14m より前へ上がるほど強く（2m で最大）、ライン裏（最終ラインの 8m 手前〜）へのパスの行き先の価値が最大 ×2.5・長いパスの減点が 0、前線が自陣深くからも裏へ走る。リスク-1（型「保持」）は lureK=0（回して保つだけ）。
- 切り替えの指示（失った直後・奪った直後）は、ボールを持つチームが替わった tick（`N[I.CHGT]`）から数秒の「窓」の間だけ効く。窓は takeControl のときだけ開く（再開・キックオフでは開かない）。
- 認知（`engine/percept.js`。視野・体の向き・気づき・味方の記憶）は既定でオン。入力 `percept: 0` で外せる（比較用。基準値にも残す）。認知ありのときだけ F の後ろに `F_FACE`・`F_SCN`、N の後ろに味方を最後に見た tick（`N_LS`）を確保する。判断は `seeAll(m, i, full)` の見え方 `aw`（味方は「いま扇の中・近く10m」か「3秒以内に見た」ときだけ候補に入る。再開の最初のプレー（`full`）は全員分かる。見えていない相手は 4 割だけ数える）を使う。ボールを持つ選手は扇が 0.8 倍。見えていない側から寄せられるとタックルに弱い（`blindOf`）。
- 入力は `createMatch` で複製される。試合中の指示変更は `setTactics(m,k,tactics)` が `m.input.changes` に `{t,k,type:'tac',tactics}` として足す（試合の記録 = 最初の入力 + changes。適用済みの数は `N[I.TACI]`。復元で `m.tac` も作り直す）。
- ボールに触れる処理は `N[I.LAST]` を直接書かず `markTouch(m,p,t)`（`engine/touchlog.js`）を使う（得点者・アシストの判定に要る）。ゴールの記録は `[t, EV.GOAL, 得点側, 得点者, アシスト(-1=なし), オウンゴール(0/1)]`。
- チェック値（`Digest`）は全ビット。実機の自己診断は `selfCheck()`（`engine/selfcheck.js`）で、基準 `data/selfcheck.js` は `npm run golden` が書く（手で編集しない）。`tools/check.html` にも出る。
- ボールの予測（`brain.js` の `predictBall`）: 空中のボールは `stepBall` を同じ刻みで進め、転がりは式で先まで求める。選手が走れる時間は「いまから先の s×0.25 秒」だけ（経過時間を足さない）。
- engine/ から render/・ui/・tools/・sim/ を import しない。

## 決定（SHO）
- 他校どうしの試合（2026-11-13）: ハイブリッド。自校・上位戦・注目校は本物のエンジン、それ以外は簡易モデルで結果だけ。保存は結果＋再現用の記録（最初の入力＋changes）。90分の試合はスマホで約1秒（iPhone実測からの見積り）。簡易モデルは、エンジンの実測（能力差→勝ち点率・得点の分布）に合わせて作る。sim/ を作るときに実装する。

## テスト
`npm test`（決定性・保存/復元・基準値・lint）。`node tools/batch.js --n 50 --check` で一括実行。
