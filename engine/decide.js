// 保持者の判断と実行（4層AIの「判断」と「実行」）。
// 選択肢（シュート・パス・スペースへのパス・ドリブル・クリア）に点数をつけ、一番高いものを選ぶ。
// 点数 = ボールを持つ価値(xt)の期待値。乱数は「見え方（点数の誤差）」と「蹴りの誤差」にだけ使う。
import { HL, HW, GOAL_HW, GOAL_H, BALL_R, F_B, F_PASS, I, ACT, EV, ST, ST_N, dirOf } from './consts.js';
import { AB, NAB } from './abil.js';
import { ROLE } from '../data/formations.js';
import { normal4 } from './core/rng.js';
import { atan2, cos, sin, log, clamp } from './core/math.js';
import { xt, xgAt, groundPass, lobPlan, timeToCover, K_ROLL, R_CTRL, REACT_BASE } from './geom.js';

const LOSS_W = 0.75; // ボールを失ったとき、相手がそこから得る価値の重み
const PASS_COST = 0.010; // パスを出すこと自体の手間（テンポが切れる・動きが読まれる）。つなぐだけのパスを減らす
const KEEP = 0.008; // ボールを持ち続けること自体の価値（失うと同じ分を失う）
const K_SHOOT = 1.0, K_DRIB = 0.85, K_PASS = 1.0; // 調整用の倍率（一括実行の数値を見て合わせる）
const U5 = [[0.5, -0.866], [0.866, -0.5], [1, 0], [0.866, 0.5], [0.5, 0.866]]; // ドリブルの向き（ゴール方向に対して -60°〜+60°）

// 点 (x,y) の周りの、相手チームの圧力（6m以内の相手の近さの合計。最大1.5）
export function pressureAt(m, x, y, k) {
  const { px, py } = m, j0 = (1 - k) * 11;
  let p = 0;
  for (let j = j0; j < j0 + 11; j++) {
    const dx = px[j] - x, dy = py[j] - y, d2 = dx * dx + dy * dy;
    if (d2 < 36) p += 1 - Math.sqrt(d2) / 6;
  }
  return p > 1.5 ? 1.5 : p;
}

// チームkから見た相手の最終ライン（相手の後ろから2人目の位置。攻める向きを+にした座標）
export function offsideLine(m, k) {
  const dir = dirOf(m.N, k), o0 = (1 - k) * 11;
  let l1 = -1e9, l2 = -1e9;
  for (let j = o0; j < o0 + 11; j++) {
    const f = m.px[j] * dir;
    if (f > l1) { l2 = l1; l1 = f; } else if (f > l2) l2 = f;
  }
  return l2;
}

// ボールが (x0,y0)→(x1,y1) を初速 v0 で転がる間に、相手に触られずに済む確率。
// 相手は①今の位置（すぐ近くを通るなら動かなくても触れる）と、②反応するまで走り続けた先の位置から、走って間に合うかで見積もる。
export function laneSafe(m, k, x0, y0, x1, y1, v0) {
  const { px, py, vx, vy, vmax, acc, ab } = m;
  const ex = x1 - x0, ey = y1 - y0, D2 = ex * ex + ey * ey, D = Math.sqrt(D2), o0 = (1 - k) * 11;
  let p = 1;
  for (let j = o0; j < o0 + 11; j++) {
    let r = 0;
    // ① 今いる場所を通る（出だしの0.2秒以内に、すぐそばを通る）
    for (let u = 0; u < 2 && r < 1; u++) { // 今の位置と、0.15秒走った先の位置
      const qx = px[j] + vx[j] * 0.15 * u, qy = py[j] + vy[j] * 0.15 * u;
      const raw = D2 > 1e-6 ? ((qx - x0) * ex + (qy - y0) * ey) / D2 : 0;
      const s = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const cx = x0 + ex * s - qx, cy = y0 + ey * s - qy;
      if (cx * cx + cy * cy <= (R_CTRL + 0.25) * (R_CTRL + 0.25) && D * s < 3) r = 1;
    }
    if (r < 1) { // ② 反応するまで走り続けた先から、間に合うか
      const rc = REACT_BASE - 0.1 + 0.02 * (20 - ab[j * NAB + AB.ANT]);
      const qx = px[j] + vx[j] * rc * 0.8, qy = py[j] + vy[j] * rc * 0.8;
      const raw = D2 > 1e-6 ? ((qx - x0) * ex + (qy - y0) * ey) / D2 : 0;
      const s = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const cx = x0 + ex * s - qx, cy = y0 + ey * s - qy, dq = Math.sqrt(cx * cx + cy * cy);
      if (dq <= R_CTRL + 0.3 && raw > 0.02) r = 1; // 進路上に立っている
      else {
        const v = v0 - K_ROLL * D * s;
        const tb = v > 0.5 ? log(v0 / v) / K_ROLL : 9; // ボールがそこへ着く時間
        const tq = rc + timeToCover(dq - R_CTRL, vmax[j], acc[j]); // 相手が着く時間（反応の遅れつき）
        const q = 0.5 + (tb - tq) / 0.5;
        r = q < 0 ? 0 : q > 1 ? 1 : q;
      }
    }
    p *= 1 - 0.9 * r;
  }
  return p;
}

// ボールを受けてから次の判断までの tick（判断力が高いほど早く、圧力が強いほど急ぐ）
export function reactTicks(m, p, press) {
  const q = clamp(1 - 0.55 * press, 0.3, 1);
  return Math.round(clamp(8 + (18 + 0.8 * (20 - m.ab[p * NAB + AB.DEC])) * q * q, 6, 50));
}

// 蹴る。向きと強さに誤差が乗る。dx,dy=狙い点、v0=水平方向の初速、vz=上向きの初速
function kick(m, i, dx, dy, v0, vz, sigAng, sigSpd, tg) {
  const { F, N, t, seed } = m, bx = F[F_B], by = F[F_B + 1];
  const a = atan2(dy - by, dx - bx) + normal4(seed, t, i, tg) * sigAng;
  const v = v0 * (1 + normal4(seed, t, i, tg + 1) * sigSpd);
  F[F_B + 3] = cos(a) * v; F[F_B + 4] = sin(a) * v; F[F_B + 5] = vz;
  F[F_B + 6] = bx; F[F_B + 7] = by;
  N[I.OWN] = -1; N[I.LAST] = i; N[I.KICKT] = m.t; m.cd[i] = 10; m.act[i] = ACT.HOME; m.tmr[i] = 0;
}

// ボールを持っている選手 i が次の行動を決めて実行する
export function decide(m, i) {
  const { px, py, vx, vy, team, slot, role, ab, vmax, acc, F, N, t, seed } = m;
  const k = team[i], dir = dirOf(N, k), A = i * NAB, gk = slot[i] === 0, j0 = k * 11, o0 = (1 - k) * 11;
  const x = px[i], y = py[i], fx = x * dir, fy = y * dir;
  const press = pressureAt(m, x, y, k), line = offsideLine(m, k);
  const sig = 0.04 + 0.008 * (20 - (ab[A + AB.DEC] + ab[A + AB.VIS]) / 2); // 見え方の誤差（点数に対する割合）
  const vis = 10 + 2.5 * ab[A + AB.VIS]; // 見える範囲 (m)
  const pas = ab[A + AB.PAS], lng = gk ? ab[A + AB.GKD] : ab[A + AB.LNG];
  const pe = 1 + 0.5 * press * (1 - 0.03 * ab[A + AB.CMP]); // 圧力による蹴りの乱れ

  let bV = -1e9, bt = 0, bj = -1, bdx = 0, bdy = 0, tag = 0;
  const consider = (V, type, j, dx, dy) => {
    const w = V * (1 + sig * normal4(seed, t, i, 100 + tag)) + 0.002 * normal4(seed, t, i, 200 + tag);
    tag++;
    if (w > bV) { bV = w; bt = type; bj = j; bdx = dx; bdy = dy; }
  };

  // --- パス（足元・スペース）---
  const evalPass = (j, space) => {
    const jx = px[j], jy = py[j], B = j * NAB;
    let dx, dy;
    if (space) { dx = jx + dir * 10; dy = jy * 0.85; } // 受け手の前のスペース
    else {
      const T0 = Math.sqrt((jx - x) * (jx - x) + (jy - y) * (jy - y)) / 16;
      dx = jx + vx[j] * T0; dy = jy + vy[j] * T0; // 動きを見越して少し先へ
    }
    dx = clamp(dx, -HL + 1.5, HL - 1.5); dy = clamp(dy, -HW + 1.5, HW - 1.5);
    const ex = dx - x, ey = dy - y, D = Math.sqrt(ex * ex + ey * ey);
    if (D < 3 || D > 55) return;
    const dfx = dx * dir, dfy = dy * dir, pd = pressureAt(m, dx, dy, k);
    let p;
    if (D <= 26) {
      const g = groundPass(D);
      if (g.v0 > 18 + 0.9 * lng) return; // 強く蹴れない距離
      p = laneSafe(m, k, x, y, dx, dy, g.v0);
      const rx = jx - dx, ry = jy - dy;
      const tr = 0.1 + timeToCover(Math.sqrt(rx * rx + ry * ry) - 0.5, vmax[j], acc[j]); // 受け手がそこへ着く時間
      const lag = tr - g.T;
      if (lag > 0.3) p *= clamp(1 - (lag - 0.3), 0, 1);
      p *= clamp(0.62 + 0.035 * ab[B + AB.TRP] + 0.012 * ab[B + AB.CMP] - 0.3 * pd - (space ? 0.06 : 0), 0.3, 0.97);
      const sg = D * Math.max(0.02, 0.1 - 0.0045 * pas) * pe;
      p *= 1 / (1 + (sg * sg) / 10.24);
    } else {
      let n = 0; // 浮き球: 着地点の周りの相手の数
      for (let q = o0; q < o0 + 11; q++) { const qx = px[q] - dx, qy = py[q] - dy; if (qx * qx + qy * qy < 49) n++; }
      p = clamp(0.66 - 0.13 * n + 0.01 * ab[B + AB.TRP], 0.15, 0.8) * 0.55; // 競り合い・ファーストタッチ・ラインを割るぶんを織り込む（実測に合わせた）
      const sg = D * Math.max(0.03, 0.12 - 0.005 * lng) * pe;
      p *= 1 / (1 + (sg * sg) / 20.25);
    }
    const V = K_PASS * (p * (xt(dfx, dfy) + KEEP) - (1 - p) * (LOSS_W * xt(-dfx, dfy) + KEEP)) + 0.012 * press * p - (D > 26 ? 0.012 : 0) - PASS_COST;
    consider(V, D <= 26 ? 2 : 3, j, dx, dy);
  };
  for (let j = j0; j < j0 + 11; j++) {
    if (j === i) continue;
    const jx = px[j], jy = py[j], ddx = jx - x, ddy = jy - y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dd < 4 || dd > vis) continue;
    if (slot[j] === 0 && fx > -22) continue; // GKへ戻すのは自陣深くだけ
    if (jx * dir > line + 0.3) continue; // すでにオフサイドの位置の味方には出さない
    evalPass(j, false);
    if (ddx * dir > -3 && (role[j] >= ROLE.M || role[j] === ROLE.S)) evalPass(j, true);
  }

  // --- シュート ---
  if (!gk) {
    const dgx = HL - fx;
    if (dgx > 0.3 && dgx < 32) {
      let block = 1;
      for (let q = o0 + 1; q < o0 + 11; q++) { // GK(スロット0)以外で、シュートコースに立つ相手
        const qf = px[q] * dir, qy = py[q] * dir;
        if (qf > fx && qf < HL) {
          const ly = fy * (1 - (qf - fx) / dgx);
          if (Math.abs(qy - ly) < 2.2) block *= 0.62;
        }
      }
      const xg = xgAt(dgx, fy) * block * (0.4 + 0.06 * ab[A + AB.SHT]) * (1 - 0.3 * press) * K_SHOOT;
      consider(xg + 0.004, 1, -1, HL * dir, 0);
    }
  }

  // --- ドリブル ---
  if (!gk) {
    for (let u = 0; u < 5; u++) {
      const dfx = clamp(fx + U5[u][0] * 7, -HL + 2, HL - 1.5), dfy = clamp(fy + U5[u][1] * 7, -HW + 1.5, HW - 1.5);
      const dx = dfx * dir, dy = dfy * dir, ex = dx - x, ey = dy - y, D2 = ex * ex + ey * ey;
      let keep = 1;
      for (let q = o0; q < o0 + 11; q++) {
        let s = D2 > 1e-6 ? ((px[q] - x) * ex + (py[q] - y) * ey) / D2 : 0;
        s = clamp(s, 0, 1);
        const cx = x + ex * s - px[q], cy = y + ey * s - py[q], d = Math.sqrt(cx * cx + cy * cy);
        if (d < 4.5) keep *= 1 - clamp(0.55 * (1 - d / 4.5) + 0.03 * (ab[q * NAB + AB.TCK] - ab[A + AB.DRI]), 0, 0.75);
      }
      consider(K_DRIB * (keep * (xt(dfx, dfy) + KEEP) - (1 - keep) * (LOSS_W * xt(-fx, fy) + KEEP)) - 0.002, 4, -1, dx, dy);
    }
  }

  // --- クリア（自陣で強く寄せられているとき）---
  if (!gk && fx < -28 && press > 0.4) consider(0.010 + 0.025 * press, 3, -1, x + dir * 36, clamp(y * 0.4, -20, 20));
  if (bt === 0) { bt = 3; bj = -1; bdx = clamp(x + dir * 40, -HL + 3, HL - 3); bdy = clamp(y * 0.3, -25, 25); } // 選択肢が無いとき

  // --- 実行 ---
  if (bt === 4) { // ドリブル: 進む先を決めて、少ししたらまた考える
    m.tx[i] = bdx; m.ty[i] = bdy; m.pc[i] = 0.5 + 0.012 * ab[A + AB.DRI]; m.tmr[i] = 12;
    N[I.ST + k * ST_N + ST.DRIB]++;
    return;
  }
  if (bt === 1) { // シュート: GKと反対側の隅を狙う
    const gyf = py[o0] * dir;
    const side = gyf > 0.3 ? -1 : gyf < -0.3 ? 1 : (normal4(seed, t, i, 30) > 0 ? 1 : -1);
    const sht = ab[A + AB.SHT];
    const ay = side * (GOAL_HW - Math.max(0.35, 1.7 - 0.08 * sht)) * dir, ax = HL * dir;
    const D = Math.sqrt((ax - x) * (ax - x) + (ay - y) * (ay - y));
    const v0 = clamp(16 + sht, 18, 32), te = D / (v0 * 0.9);
    let vz = clamp((0.9 + 4.9 * te * te - BALL_R) / te, 0.5, 9) + normal4(seed, t, i, 34) * 1.1;
    if (vz < 0) vz = 0;
    kick(m, i, ax, ay, v0, vz, Math.max(0.025, 0.22 - 0.008 * sht) * (1 + 0.35 * press) * clamp(D / 18, 0.6, 1.4), 0.06, 36);
    N[I.SHOTS + k]++; N[I.SHOTK] = k; N[I.SHOTT] = t;
    m.log.push([t, EV.SHOT, k, i]);
    const vxb = F[F_B + 3], vyb = F[F_B + 4]; // 枠内かどうか（直進で見積もる。統計用）
    if (vxb * dir > 1) {
      const tc = (HL * dir - F[F_B]) / vxb, yc = F[F_B + 1] + vyb * tc, zc = BALL_R + vz * tc - 4.9 * tc * tc;
      if (Math.abs(yc) < GOAL_HW && zc > 0 && zc < GOAL_H) N[I.ST + k * ST_N + ST.SOT]++;
    }
    return;
  }
  const dd = Math.sqrt((bdx - x) * (bdx - x) + (bdy - y) * (bdy - y));
  if (bt === 2) kick(m, i, bdx, bdy, groundPass(dd).v0, 0, Math.max(0.02, 0.1 - 0.0045 * pas) * pe, 0.05, 30);
  else {
    const l = lobPlan(dd);
    N[I.ST + k * ST_N + (bj >= 0 ? ST.LOB : ST.CLR)]++;
    kick(m, i, bdx, bdy, l.vh, l.vz, Math.max(0.03, 0.12 - 0.005 * lng) * pe, 0.06, 30);
  }
  if (bj >= 0) {
    N[I.RECV] = bj; N[I.PASSK] = k; F[F_PASS] = bdx; F[F_PASS + 1] = bdy;
    N[I.ST + k * ST_N + ST.PASS]++;
    const r = role[i];
    if (r === ROLE.S || r >= ROLE.M) { m.act[i] = ACT.FOLLOW; m.tmr[i] = 40; } // 出したあとも前へ関わる
  } else { N[I.RECV] = -1; N[I.PASSK] = -1; }
}
