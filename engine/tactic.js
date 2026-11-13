// チーム指示（data/tactics.js の -1〜+1）から、エンジンが使う数値を作る。入力から決まる値（状態ではない）。
// どの数値も「0 のとき、これまでの動き（定数）とまったく同じ」になるように、標準値を真ん中に置いて -1 側・+1 側へ伸ばす。
import { normTactics } from '../data/tactics.js';

// t = -1 のとき lo、0 のとき mid、+1 のとき hi（途中は直線）
const sc = (t, lo, mid, hi) => (t < 0 ? mid + (mid - lo) * t : mid + (hi - mid) * t);
const c1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

// 役割ごとの効き方。順は G C S D M W A F。FRONT_W: 前線の押し上げ（プレス開始位置）。LINE_W: ブロックの前後（ライン高さ。前線ほど小さい = 高いラインは縦を詰め、低いラインは間が空く）
export const FRONT_W = [0, 0, 0, 0.15, 0.3, 0.6, 0.6, 1];
export const LINE_W = [0, 1, 1, 1, 0.85, 0.7, 0.7, 0.55];

// 守備の数値。ex は「失った直後」の窓の間だけ変わる値: markPc=マークの走る強さ（標準 0.5）、recPc=戻る走りの強さ（0=標準のまま）、nPress=同時に寄せる人数（標準 1）
function defParams(t, ex) {
  const L = t.line, C = t.compact, Z = t.pressZone, P = t.pressPower, S = t.defStyle;
  return {
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
    markPc: ex.markPc, recPc: ex.recPc, nPress: ex.nPress,
  };
}

// 攻撃の数値（幅・テンポ・攻め方・リスクのパス側・組み立て）。どれも 0 のとき、これまでの値と同じ。
function atkParams(t) {
  const W = t.width, T = t.tempo, A = t.attack, R = t.risk, B = t.build;
  return {
    // 組み立て: ショートパスでつなぐ(-) ←→ ロングボールで進める(+)。longPen/longBon=長いパス(26m超)の減点（標準 0.012）と加点、shortB=短いパス(14m未満)の加点、
    //     backB=後ろ向きのパスの加点（-側だけ）、clrK=クリアの価値の倍率、clrLoss=クリアで手放す減点（-側だけ。標準 0）、
    //     gkFx=GKへ戻してよい位置（自陣のこの前後位置より後ろ。標準 -22m）、reliefK=相手の圧力から逃れるパスの加点の倍率（標準 1）
    longPen: sc(B, 0.024, 0.012, 0.005), longBon: B > 0 ? 0.003 * B : 0, shortB: sc(B, 0.004, 0, -0.003), backB: sc(B, 0.004, 0, 0), clrK: sc(B, 0.5, 1, 1.3), clrLoss: sc(B, 0.02, 0, 0), gkFx: sc(B, -12, -22, -22), reliefK: sc(B, 1.8, 1, 0.6),
    // 幅: 攻撃中の持ち場の横の広がり（倍率）・逆サイドの選手がボール側へ寄る割合（標準 0.12。広いほど持ち場を保つ）・サポートに入る距離の好み（m）。
    //     広い(+)では、ハーフスペースとライン間（相手の中盤の線と最終ラインのあいだ）で受ける加点も効く（ポジショナルプレー・5レーン）
    wideK: sc(W, 0.8, 1, 1.12), farShift: sc(W, 0.3, 0.12, 0), supR: sc(W, 8, 11, 14), hsK: W > 0 ? 0.8 * W : 0, btwK: W > 0 ? W : 0,
    // テンポ: 判断までの時間（倍率）・パスを出す手間・持ち続けてよい時間（秒）・サポートに入る選手の走る強さ
    reactK: sc(T, 1.3, 1, 0.7), passCost: sc(T, 0.0115, 0.010, 0.0065), hold0: sc(T, 2.0, 1.5, 0.9), supPc: sc(T, 0.45, 0.55, 0.7),
    // 攻め方: 行き先の価値を横位置で増減する強さ（サイド(+)は大外・ハーフスペースが得、中央(-)は逆）・ウイングの持ち場（内へ絞る〜大外）・SBの上がりの倍率
    latK: 0.35 * A, wingK: sc(A, 0.75, 1, 1.1), sbUpK: sc(A, 0.6, 1, 1.3),
    // リスク（パス側）: 失う重みの倍率・撃つ意識の倍率。（後ろの残し方は restN・tuckK）
    lossK: sc(R, 1.3, 1, 0.7), shtK: sc(R, 0.9, 1, 1.15),
    // 冒険する(+)ほど、最終ラインから前線までが前へ出て（全員で攻める。最大 +3.5 倍）、裏へ走る人が1人増える。安全に(-)は少し控える（-0.5 倍）
    push: R > 0 ? 3.5 * R : 0.5 * R, runPlus: R > 0.5 ? 1 : R < -0.5 ? -1 : 0,
  };
}

export function tacParams(raw) {
  const t = normTactics(raw), Ls = t.onLose, Wn = t.onWin, R = t.risk;
  const p = defParams(t, { markPc: 0.5, recPc: 0, nPress: 1 });
  p.t = t;
  Object.assign(p, atkParams(t));
  // 切り替え（失った直後）: 失ってから loseW tick の間は、守備の数値が tacT に替わる（0 = 窓なし = 標準のまま）。窓の長さは最大 6 秒（ゲーゲンプレスの通説の 5〜6 秒）
  // すぐ奪い返す(+): 寄せの強さ・開始位置を上げ、ラインとコンパクトさも前へ。寄せる人数は 1〜3 人（最大 6 秒）。すぐ戻る(-): 最初の1人は間合いを取って遅らせ、ほかは全力で戻る・ラインを下げる（最大 4 秒）
  p.loseW = Ls === 0 ? 0 : Math.round((Ls > 0 ? 120 : 80) * Math.abs(Ls));
  p.tacT = Ls > 0
    ? defParams({ ...t, pressPower: c1(t.pressPower + Ls), pressZone: c1(t.pressZone + Ls), compact: c1(t.compact + 0.6 * Ls), line: c1(t.line + 0.4 * Ls) },
      { markPc: 0.5 + 0.25 * Ls, recPc: 0, nPress: Ls > 0.75 ? 3 : Ls > 0.25 ? 2 : 1 })
    : Ls < 0
      ? defParams({ ...t, pressPower: c1(t.pressPower + 0.6 * Ls), line: c1(t.line + 0.8 * Ls), compact: c1(t.compact - 0.3 * Ls) }, { markPc: 0.5, recPc: 0.5 - 0.4 * Ls, nPress: 1 })
      : null;
  // 切り替え（奪った直後）: 奪ってから winW tick の間、保持側の動きが変わる（縦に速く(+): 判断が速く・リスクを取り・前線が走る。キープ(-): 落ち着いて安全に）
  p.winW = Wn === 0 ? 0 : Math.round(120 * Math.abs(Wn));
  // リスク（攻撃中の後ろの残し方）: 安全に(-) は CB 以外の深い選手（SB・守備的な中盤の順）を 1〜3 人ハーフウェー付近に残し、逆サイドの SB も絞る。冒険する(+) は逆サイドの SB も絞らず上がる
  p.restN = R < 0 ? Math.round(-3 * R) : 0;
  p.tuckK = sc(R, 1.5, 1, 0);
  return p;
}
