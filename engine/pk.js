// PK戦（延長でも同点のときの決着）。位置につく → 構える → 助走 → 蹴る → 結果、の手順を状態 N だけで進める（途中で保存・復元できる）。
// ボールの物理とGKの手の届く範囲は通常のプレーと同じもの（ball.js、brain.js の touches）を使い、GKが跳ぶ動きだけをここで決める。
// 全員が同じゴール（+x）へ蹴る。蹴らない選手はセンターサークルで待つ。
import { NP, HL, GOAL_HW, BALL_R, PEN_X, DT, F_B, I, PHASE, EV, ACT } from './consts.js';
import { AB, NAB } from './abil.js';
import { stepBall, BALL_EV } from './ball.js';
import { movePlayers, touches } from './brain.js';
import { f4, normal4, hash4 } from './core/rng.js';
import { atan2, cos, sin, clamp } from './core/math.js';

const SPOT_X = HL - PEN_X; // ペナルティマーク
const GK_X = HL - 0.4; // 守るGKが立つ位置（ゴールライン上）
const WAIT_GK_Y = 8; // 蹴らない側のGKが待つ位置（ゴールの脇）
const TWO_PI = 6.283185307179586;
const DIVE_TICKS = 10; // GKが跳び切るまでの時間（0.5秒）
// 調整用（実測で合わせる）
// 実測（能力10同士の300本: ゴール約73%・セーブ約18%・外れ約9%。実際のPK戦は約75%・15〜17%・7〜10%）で合わせた
const DIVE0 = 1.0, DIVE1 = 0.05; // GKが跳ぶ横の距離 = DIVE0 + DIVE1 × 反応(GKR)
const REACH0 = 0.3, REACH1 = 0.03; // 跳んだときに手が届く範囲 = REACH0 + REACH1 × GKR（通常のプレーの届く範囲より狭い）
const ANG0 = 0.15; // キックの向きのばらつき（rad）= ANG0 − 0.006×シュート − 0.004×落ち着き

// チームごとのキッカー順（スロット番号）。シュートと落ち着き（CMP）が強い順で、GKは最後。入力から決まる値（状態ではない）。
export function pkOrder(m) {
  const o = new Uint8Array(NP);
  for (let k = 0; k < 2; k++) {
    const s = [], sc = (q) => m.ab[(k * 11 + q) * NAB + AB.SHT] + 0.5 * m.ab[(k * 11 + q) * NAB + AB.CMP];
    for (let q = 1; q < 11; q++) s.push(q);
    s.sort((a, b) => sc(b) - sc(a) || a - b);
    s.push(0);
    for (let q = 0; q < 11; q++) o[k * 11 + q] = s[q];
  }
  return o;
}

// n 本が蹴られたあと、チーム team が蹴った本数（first = 先攻のチーム）
const taken = (n, first, team) => (n + (first === team ? 1 : 0)) >> 1;

// 勝敗が決まったか。a, b = チーム0・1の蹴った本数、ga, gb = 得点。決まったら勝ったチーム（0 / 1）、まだなら -1。
// 5本ずつの間は、残りを全部決めても追いつけなければ決着。5本ずつ蹴り終えたら、同じ本数で差がついた時点で決着（サドンデス）。
export function pkDecided(a, b, ga, gb) {
  const ra = a < 5 ? 5 - a : 0, rb = b < 5 ? 5 - b : 0;
  if (ra > 0 || rb > 0) {
    if (ga > gb + rb) return 0;
    if (gb > ga + ra) return 1;
    return -1;
  }
  return a === b && ga !== gb ? (ga > gb ? 0 : 1) : -1;
}

// 現在の状態から、決着したか（勝ったチーム、まだなら -1）
export function pkWinner(N) {
  const n = N[I.PKN], f = N[I.PKF];
  return pkDecided(taken(n, f, 0), taken(n, f, 1), N[I.PKG], N[I.PKG + 1]);
}

const circle = (i) => { const a = (TWO_PI * (i + 0.5)) / NP; return [6.5 * cos(a), 6.5 * sin(a)]; };

export function startPK(m) {
  const { N, px, py, vx, vy } = m;
  N[I.PHASE] = PHASE.PK; N[I.HALF] = 5;
  m.log.push([m.t, EV.PK, N[I.SCORE], N[I.SCORE + 1]]);
  N[I.PKF] = hash4(m.seed, 0, 0, 801) & 1; // 先攻（コイントス）
  N[I.PKN] = 0; N[I.PKG] = 0; N[I.PKG + 1] = 0;
  beginKick(m);
  for (let i = 0; i < NP; i++) { // 全員をいったん所定の位置へ（蹴る選手はセンターサークルから歩き出す）
    const c = circle(i);
    vx[i] = vy[i] = 0;
    if (i === N[I.TAKER]) { px[i] = c[0]; py[i] = c[1]; } else { px[i] = m.tx[i]; py[i] = m.ty[i]; }
  }
}

// 次の1本の準備: 蹴る選手を決め、位置を指示し、ボールをマークに置く
function beginKick(m) {
  const { N, F, tx, ty, pc, act, tgt, cd } = m;
  const n = N[I.PKN], kk = N[I.PKF] ^ (n & 1), g = (1 - kk) * 11, wg = kk * 11;
  const ki = kk * 11 + m.pkOrder[kk * 11 + ((n >> 1) % 11)];
  N[I.PKK] = kk; N[I.TAKER] = ki; N[I.PKS] = 0; N[I.PKT] = 0; N[I.PKR] = -1; N[I.PKD] = 0;
  N[I.OWN] = -1; N[I.LAST] = -1; N[I.RECV] = -1; N[I.PASSK] = -1; N[I.SHOTK] = -1; N[I.LOCK] = 0;
  for (let i = 0; i < NP; i++) {
    const c = circle(i);
    tx[i] = c[0]; ty[i] = c[1]; pc[i] = 0.55; act[i] = ACT.HOME; tgt[i] = -1; cd[i] = 0;
  }
  tx[g] = GK_X; ty[g] = 0; pc[g] = 0.7;
  tx[wg] = HL - 1.5; ty[wg] = wg === 0 ? -WAIT_GK_Y : WAIT_GK_Y; pc[wg] = 0.7; // 蹴らない側のGKはゴールの脇
  tx[ki] = SPOT_X - 3.2; ty[ki] = 0.9; act[ki] = ACT.CARRY; // 助走の始めの位置
  F[F_B] = F[F_B + 6] = SPOT_X; F[F_B + 1] = F[F_B + 7] = 0; F[F_B + 2] = BALL_R;
  F[F_B + 3] = F[F_B + 4] = F[F_B + 5] = 0;
}

const dist = (m, i, x, y) => { const dx = m.px[i] - x, dy = m.py[i] - y; return Math.sqrt(dx * dx + dy * dy); };

// 1 tick 進める
export function stepPK(m) {
  const { N, px, py, vx, vy, tx, ty, pc } = m;
  const st = N[I.PKS], ki = N[I.TAKER], kk = N[I.PKK], g = (1 - kk) * 11;
  movePlayers(m);
  if (st === 0) { // 位置につく（蹴る選手は助走の位置へ、GKはゴールへ）
    const t = ++N[I.PKT];
    if ((dist(m, ki, tx[ki], ty[ki]) < 1.0 && dist(m, g, tx[g], ty[g]) < 0.8) || t >= 300) {
      if (t >= 300) { // 間に合わなかった分は置く
        px[ki] = tx[ki]; py[ki] = ty[ki]; vx[ki] = vy[ki] = 0; px[g] = tx[g]; py[g] = ty[g]; vx[g] = vy[g] = 0;
      }
      N[I.PKS] = 1; N[I.PKT] = 30; // 1.5秒ほど構える
    }
  } else if (st === 1) {
    if (--N[I.PKT] <= 0) { tx[ki] = SPOT_X - 0.4; ty[ki] = 0; pc[ki] = 0.7; N[I.PKS] = 4; N[I.PKT] = 0; } // 助走
  } else if (st === 4) {
    if (dist(m, ki, SPOT_X - 0.4, 0) < 0.9 || ++N[I.PKT] >= 40) takeKick(m);
  } else if (st === 2) flight(m);
  else if (--N[I.PKT] <= 0) { // 結果を見せ終わった
    if (pkWinner(N) >= 0) {
      N[I.PHASE] = PHASE.END;
      m.log.push([m.t, EV.FULL, N[I.SCORE], N[I.SCORE + 1], N[I.PKG], N[I.PKG + 1]]);
    } else beginKick(m);
  }
}

// キッカーが蹴る。コース（左右・高さ）は選手が選び、能力と落ち着き、決着のかかる一本かどうかでばらつく。GKは蹴る瞬間に跳ぶ向きを決める。
function takeKick(m) {
  const { N, F, ab, seed, t, tx, ty, pc } = m;
  const i = N[I.TAKER], kk = N[I.PKK], g = (1 - kk) * 11, A = i * NAB, B = g * NAB, n = N[I.PKN], first = N[I.PKF];
  const sht = ab[A + AB.SHT], cmp = ab[A + AB.CMP];
  const na = taken(n + 1, first, 0), nb = taken(n + 1, first, 1), g0 = N[I.PKG], g1 = N[I.PKG + 1];
  const tense = pkDecided(na, nb, g0 + (kk === 0 ? 1 : 0), g1 + (kk === 1 ? 1 : 0)) >= 0 || pkDecided(na, nb, g0, g1) >= 0 ? 1 : 0; // 決めても外しても決着
  const nerv = (0.25 + 0.5 * tense) * (1 - cmp / 25); // 緊張によるばらつきの増え方（落ち着きで減る）
  const side = f4(seed, t, i, 810) < 0.5 ? -1 : 1;
  const ay = side * (GOAL_HW - Math.max(0.35, 1.9 - 0.09 * sht)), zt = 0.35 + 1.25 * f4(seed, t, i, 811);
  const bx = F[F_B], by = F[F_B + 1], D = Math.sqrt((HL - bx) * (HL - bx) + (ay - by) * (ay - by));
  const v0 = clamp(18 + 0.7 * sht, 20, 30), te = D / (v0 * 0.9);
  let vz = (zt + 4.9 * te * te - BALL_R) / te + normal4(seed, t, i, 812) * 0.8 * (1 + nerv);
  if (vz < 0) vz = 0;
  const a = atan2(ay - by, HL - bx) + normal4(seed, t, i, 813) * Math.max(0.03, ANG0 - 0.006 * sht - 0.004 * cmp) * (1 + nerv);
  const v = v0 * (1 + normal4(seed, t, i, 814) * 0.03);
  F[F_B + 3] = cos(a) * v; F[F_B + 4] = sin(a) * v; F[F_B + 5] = vz;
  N[I.LAST] = i; N[I.KICKT] = t; m.cd[i] = 10;
  tx[i] = SPOT_X + 1.2; ty[i] = 0; pc[i] = 0.4; // 蹴ったあとの流れ
  const u = f4(seed, t, g, 815), pg = 0.46 + 0.012 * (ab[B + AB.GK1] - 10); // 蹴る側と同じ向きへ跳ぶ確率（反対向きは残りから中央待ちを除いた分）
  N[I.PKD] = u < pg ? side : u < 0.92 ? -side : 0;
  N[I.PKS] = 2; N[I.PKT] = 0;
}

// ボールが飛んでいる間: GKが跳び、ゴール・外れ・GKが触れた（セーブ）のどれかになったら結果を決める
function flight(m) {
  const { N, F, px, py, vx, vy, ab } = m;
  const kk = N[I.PKK], g = (1 - kk) * 11, tk = ++N[I.PKT];
  const prog = Math.min(1, tk / DIVE_TICKS);
  px[g] = GK_X; py[g] = N[I.PKD] * (DIVE0 + DIVE1 * ab[g * NAB + AB.GKR]) * prog * (2 - prog); vx[g] = vy[g] = 0;
  F[F_B + 6] = F[F_B]; F[F_B + 7] = F[F_B + 1];
  const ev = stepBall(F, F_B, DT);
  let res = -1;
  if (ev === BALL_EV.GOAL_PX) res = 1;
  else if (ev !== BALL_EV.NONE) res = 0;
  else {
    const r0 = m.rgk[g]; m.rgk[g] = REACH0 + REACH1 * ab[g * NAB + AB.GKR];
    touches(m);
    m.rgk[g] = r0;
    if (N[I.LAST] === g) res = 2; else if (tk >= 80) res = 0;
  }
  if (res < 0) return;
  N[I.PKR] = res; N[I.PKS] = 3; N[I.PKT] = 60; // 3秒ほど結果を見せる
  if (res === 1) N[I.PKG + kk]++;
  N[I.PKN]++;
  m.log.push([m.t, EV.PKK, kk, N[I.TAKER], res]);
}
