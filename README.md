# hi-school-football

高校サッカー監督シミュレーション。サーバーなしの静的PWA、素のJavaScript（ESモジュール、ビルドなし）。
設計書は claude.ai の Project「高校サッカー監督」（`claude/設計書.md` ほか）。

## 現在地: 段階1（エンジンの土台）
- メートル基準・20Hz固定刻みの試合ループ、ボール物理、得点・場外・再開、前後半
- 端末が違っても同じ結果になる乱数と数学関数（`engine/core/`）
- 途中の保存と復元（`snapshot` / `restore`）、状態のチェック値（`digestMatch`）
- 一括実行ツール、2D表示（`render/`）、自動テスト
- **AIは仮**（ボールに近い選手が追って蹴るだけ）。段階2で判断AIに置き換える

## コマンド
PowerShell 5.x は `&&` が使えないので `;` で区切る。

```
node tools/test.js                       # 自動テスト（npm test でも可）
node tools/batch.js --n 50 --check       # 同じ設定で50試合。--check は再現性も確認
node tools/golden.js --write             # 基準値の更新（エンジンを意図して変えたときだけ）
```

## ブラウザで見る
ESモジュールはファイルを直接開いても動かない。デプロイ先（Vercel）のURLで開く。
- `/tools/viewer.html` … 試合を上から見る（速度×1〜×60）
- `/tools/check.html` … この端末で試合が基準値と同じ展開になるか（iPhoneのSafariでも確認できる）

## フォルダ
```
engine/   試合エンジン（画面に依存しない純粋なJS。Worker と Node の両方で動く）
  core/   決定的な数学・乱数・チェック値
sim/      週進行・成長・勧誘・他校・卒業生の人生・セーブ移行（未着手）
data/     県ごとのデータ、フォーメーションなど
ui/       各画面（未着手）
render/   試合の2D/3D描画、顔の生成
tools/    テスト、一括実行、確認ページ
```

## エンジンの決まり（試合の再現性のため）
- `engine/` の中では Math の sin/cos/atan2/exp/log/pow/hypot/random、`**`、Date、performance を使わない。
  代わりに `engine/core/math.js` の関数を使う（`tools/test.js` が検査する）。
- 乱数は `hash4(試合の種, tick, 選手, 用途)` のように、用途と対象から作る（順番に依存しない）。
- 試合の状態は `F`（Float64Array）・`N`（Int32Array）・`log` だけ。AIの内部状態もここに入れる。
- エンジンの結果が変わる修正をしたら `ENGINE_VERSION` を上げ、`golden.json` を更新する。
