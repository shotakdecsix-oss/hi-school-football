// チーム指示（data/tactics.js の -1〜+1）から、エンジンが使う数値を作る。入力から決まる値（状態ではない）。
// どの数値も「0 のとき、これまでの動き（定数）とまったく同じ」になるように、標準値を真ん中に置いて -1 側・+1 側へ伸ばす。
import { normTactics } from '../data/tactics.js';

// t = -1 のとき lo、0 のとき mid、+1 のとき hi（途中は直線）
const sc = (t, lo, mid, hi) => (t < 0 ? mid + (mid - lo) * t : mid + (hi - mid) * t);

// 役割ごとの効き方。順は G C S D M W A F。FRONT_W: 前線の押し上げ（プレス開始位置）。LINE_W: ブロックの前後（ライン高さ。前線ほど小さい = 高いラインは縦を詰め、低いラインは間が空く）
export const FRONT_W = [0, 0, 0, 0.15, 0.3, 0.6, 0.6, 1];
export const LINE_W = [0, 1, 1, 1, 0.85, 0.7, 0.7, 0.55];

export function tacParams(raw) {
  const t = normTactics(raw);
  const L = t.line, C = t.compact, Z = t.pressZone, P = t.pressPower, S = t.defStyle;
  return {
    t,
    // ライン高さ: 守備のときのブロック全体の前後（m）。低いラインではゴール前の最低の深さも少し浅くなれる。守備のGKの前進（m）。
    // hold: ラインを守る選手（CB・SB・守備的MF）がマークに付いて持ち場（ライン）から前後に動ける幅（m）。0 = 制限なし（標準）。高い・低いの指示ほど、ラインを崩さない
    lineOff: sc(L, -12, 0, 16), floorD: sc(L, 10.5, 13, 13), gkUp: sc(L, -1.5, 0, 4), hold: L === 0 ? 0 : 4 + 40 * (1 - Math.abs(L)) * (1 - Math.abs(L)),
    // コンパクトさ: 縦の詰め（小さいほど詰まる）・横幅・ボール側への寄り
    comprD: sc(C, 0.9, 0.78, 0.52), widthD: sc(C, 0.9, 0.8, 0.64), shiftY: sc(C, 0.35, 0.42, 0.56),
    // プレス開始位置: ボールがこの位置（自チームの攻める向きを+、m）より前にあるときは寄せない。前線の押し上げ（m）
    zMax: Z < 0 ? 52.5 + 70 * Z : 99, frontOff: sc(Z, -10, 0, 12),
    // プレス強度: 寄せに行く範囲(m)・間合い・近づく速さ・マークの深さと、ボール側へのコース切り・タックルの出しやすさ
    pressR: sc(P, 28, 32, 38), jdK: sc(P, 1.1, 1, 0.93), pcNear: sc(P, 0.62, 0.7, 0.8), gsK: sc(P, 1.1, 1, 0.88),
    laneCut: sc(P, 0.6, 0.8, 1.4), tklK: sc(P, 0.88, 1, 1.15),
    // 守り方: マークする相手を探す範囲（持ち場から。2乗）と、持ち場から離れて付いていける距離（2乗）
    // ゾーンの指示ほど、マークに付いていても持ち場へ戻る力が働く（zoneBlend）。コンパクトの指示ほど、ボールから遠い相手はマークしない（releaseR2。ボール側へ寄って守る）
    markR2: sc(S, 81, 196, 484), leash2: sc(S, 144, 400, 1225), zoneBlend: S < 0 ? -0.5 * S : 0, releaseR2: C > 0 ? (62 - 38 * C) * (62 - 38 * C) : 1e6,
  };
}
