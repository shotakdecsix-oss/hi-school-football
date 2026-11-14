// 選手の能力（32個）の並び。データ設計の ab 配列と同じ順。値は 1〜20（絶対評価）。
export const AB = {
  // 技術(10)
  PAS: 0, LNG: 1, TRP: 2, DRI: 3, SHT: 4, CRS: 5, HED: 6, TCK: 7, MRK: 8, SET: 9,
  // メンタル(10)
  DEC: 10, VIS: 11, OFF: 12, POS: 13, ANT: 14, CMP: 15, CON: 16, WRK: 17, AGG: 18, LDR: 19,
  // フィジカル(7)
  SPD: 20, ACC: 21, AGI: 22, STM: 23, STR: 24, JMP: 25, BAL: 26,
  // GK(5)
  GKR: 27, GKC: 28, GK1: 29, GKH: 30, GKD: 31,
};
export const NAB = 32;

// 入力の ab を 32個の配列にする。数値ならすべて同じ値（仮の総合力）、配列ならそのまま。
export function abVec(x) {
  const v = new Float64Array(NAB);
  if (typeof x === 'number') v.fill(x);
  else for (let k = 0; k < NAB; k++) v[k] = x[k];
  return v;
}

// 能力の「効き」を寝かせる（v15）。エンジンは能力そのものではなく、基準値 A からの差を AB_G 倍に縮めた実効値 A + AB_G × (能力 − A) を使う。
// 基準値 A は、外野手の能力なら 10。GK だけが使う能力（反応・キャッチ・1対1・ハンドリング・配球）は「GK の標準」（GK_ANCHOR。10 + 標準のGKの上乗せ）。
//   外野手の 10 と比べても意味がない能力なので、標準のGKはそのままの値で動き、GK どうしの差だけが縮む（標準のGKまで弱くならない）。
// 較正: 全能力が一律に差 d 違うチーム同士の結果が、現実の統計（サッカーのEloレーティング。能力1点≒90点）に合うように決めた。
//   測定（90分・各100〜150試合）: 差 1・3・5 で 得点比の対数 0.30・1.30・1.90 → 勝ち点率（得点3〜4点のポアソン近似）60・85・93%（目標 63・83・93%）。
//   圧縮前（G=1）は差1で 1.5 前後（約5倍の傾き）、G=0.23 では 差3・5 が目標より 2〜4 ポイント低かった。
// 一部の能力だけ・1人だけ高い場合の効きも同じ比で小さくなる（個人の影響は、圧縮前の約 1/3〜1/4）。基準値の選手は変わらない。
export const AB_ANCHOR = 10, AB_G = 0.18;
export const GK_ANCHOR = { GKR: 14, GKC: 14, GK1: 13, GKH: 13, GKD: 12 }; // engine/sample.js の標準のGK（GKR+4・GKC+4・GK1+3・GKH+3・GKD+2）と同じ
const ANCHOR = Array.from({ length: NAB }, (_, k) => AB_ANCHOR);
for (const [n, a] of Object.entries(GK_ANCHOR)) ANCHOR[AB[n]] = a;
// 能力ごとの効き倍率（既定は AB_G）。試験・計測が差し替えられるように配列で公開する（tools/sens.js の --gain）。決まった値は下で AB_G から上書きする。
export const AB_GA = Array.from({ length: NAB }, () => AB_G);
// 能力ごとの倍率（v18）。全部の能力が試合に出るようにする（測り方は tools/sens.js の回帰と、片方 +6・片方 −6 の対比）。
// 速さは効きすぎ（回帰の傾きが他の2〜5倍）なので小さく、使い道の効きが小さい能力（敏捷・スタミナ・パス・守備の読み・動き出し・運動量・判断・視野・GK）は大きく。ほかは AB_G のまま。
// 全体の大きさは、能力が一律に差 d 違うチームどうし（tools/calib.js。全能力同じ値・league・各80〜120試合）で決めた: 勝ち点率 d=3・5 で 84・94%（目標 83・93%）、得点比の対数 0.3・1.5・2.2 前後（目標 0.30・1.30・1.90。目標より少し得点が偏る）。
for (const [n, g] of Object.entries({ SPD: 0.11, ACC: 0.11, AGI: 0.5, STM: 0.4, SHT: 0.26, PAS: 0.34, LNG: 0.34, POS: 0.41, MRK: 0.41, OFF: 0.48, WRK: 0.5, DEC: 0.6, VIS: 0.6, GKR: 0.34, GKC: 0.34, GK1: 0.34, GKH: 0.34, GKD: 0.27 })) AB_GA[AB[n]] = g;
export function effVec(x) {
  const v = abVec(x);
  for (let k = 0; k < NAB; k++) v[k] = ANCHOR[k] + AB_GA[k] * (v[k] - ANCHOR[k]);
  return v;
}
