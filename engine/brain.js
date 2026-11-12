// 仮のAI（段階2で判断AIに置き換える）。ボールに近い選手が追いかけ、触れたら蹴るだけ。
// 目的は「固定刻みの試合ループ・乱数・保存と復元」が正しく動くことの確認で、サッカーとしての出来は見ない。
import { NP, DT, HL, HW, GOAL_HW, F_B, I, EV, dirOf } from './consts.js';
import { hash4, normal4 } from './core/rng.js';
import { atan2, cos, sin, clamp } from './core/math.js';

const INV32 = 1 / 4294967296;
const R_CTRL = 0.9; // ボールを扱える距離 (m)
const R_GK = 2.0; // GKは飛びつけるので広い
const ACC = 6.0; // 加減速の上限 (m/s²)
const rf = (m, i, tag) => hash4(m.seed, m.t, i, tag) * INV32; // この tick・この選手・この用途の乱数 [0,1)

// 各選手の目標位置を決める
export function think(m) {
  const { px, py, tx, ty, team, slot, fd, fl, F, N } = m;
  const bx = F[F_B], by = F[F_B + 1];
  let c0 = -1, c1 = -1, d0 = 1e18, d1 = 1e18;
  for (let i = 0; i < NP; i++) {
    if (slot[i] === 0) continue;
    const dx = px[i] - bx, dy = py[i] - by, d = dx * dx + dy * dy;
    if (team[i] === 0) { if (d < d0) { d0 = d; c0 = i; } } else if (d < d1) { d1 = d; c1 = i; }
  }
  const lx = bx + F[F_B + 3] * 0.4, ly = by + F[F_B + 4] * 0.4;
  for (let i = 0; i < NP; i++) {
    const dir = dirOf(N, team[i]);
    if (slot[i] === 0) {
      tx[i] = -dir * (HL - 2);
      ty[i] = clamp(by * 0.4, -3, 3);
    } else if (i === c0 || i === c1) {
      tx[i] = lx; ty[i] = ly; // 各チームで一番近い選手がボールを追う
    } else {
      const hx = dir * (fd[i] * (2 * HL) - HL), hy = fl[i] * (HW * 0.9) * dir;
      tx[i] = hx + (bx - hx) * 0.2; // 持ち場から少しだけボール寄りに
      ty[i] = hy + (by - hy) * 0.2;
    }
  }
}

// 目標へ向かって、最高速度と加速度の範囲で動く
export function movePlayers(m) {
  const { px, py, vx, vy, tx, ty, spd } = m;
  const lim = ACC * DT;
  for (let i = 0; i < NP; i++) {
    const dx = tx[i] - px[i], dy = ty[i] - py[i];
    const d = Math.sqrt(dx * dx + dy * dy);
    let wx = 0, wy = 0;
    if (d > 1e-6) {
      const s = Math.min(spd[i], d * 2.5) / d; // 近づくほど減速
      wx = dx * s; wy = dy * s;
    }
    let ax = wx - vx[i], ay = wy - vy[i];
    const da = Math.sqrt(ax * ax + ay * ay);
    if (da > lim) { const s = lim / da; ax *= s; ay *= s; }
    vx[i] += ax; vy[i] += ay;
    px[i] = clamp(px[i] + vx[i] * DT, -HL - 2, HL + 2);
    py[i] = clamp(py[i] + vy[i] * DT, -HW - 2, HW + 2);
  }
}

// ボールの軌跡（前tick→今tick）に一番近づいた選手が触る
export function touches(m) {
  const { px, py, team, slot, cd, F, N } = m;
  const ax = F[F_B + 6], ay = F[F_B + 7], bx = F[F_B], by = F[F_B + 1], bz = F[F_B + 2];
  const ex = bx - ax, ey = by - ay, ee = ex * ex + ey * ey;
  const lock = N[I.LOCK] > 0 ? N[I.LOCKT] : -1;
  let best = -1, bd = 1e18;
  for (let i = 0; i < NP; i++) {
    if (cd[i] > 0 || (lock >= 0 && team[i] !== lock)) continue;
    const gk = slot[i] === 0;
    if (bz > (gk ? 2.6 : 1.3)) continue;
    let s = ee > 1e-9 ? ((px[i] - ax) * ex + (py[i] - ay) * ey) / ee : 1;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const dx = ax + ex * s - px[i], dy = ay + ey * s - py[i], d2 = dx * dx + dy * dy;
    if (d2 < (gk ? R_GK * R_GK : R_CTRL * R_CTRL) && d2 < bd) { bd = d2; best = i; }
  }
  if (best >= 0) kick(m, best);
}

function pickMate(m, i, dir, r) {
  const { team, slot, px, F } = m;
  const k = team[i], bx = F[F_B], j0 = k * 11;
  let n = 0;
  for (let j = j0; j < j0 + 11; j++) if (j !== i && slot[j] !== 0 && dir * (px[j] - bx) > -2) n++;
  if (n === 0) return -1;
  let c = Math.floor(r * n);
  for (let j = j0; j < j0 + 11; j++) {
    if (j !== i && slot[j] !== 0 && dir * (px[j] - bx) > -2) { if (c === 0) return j; c--; }
  }
  return -1;
}

function kick(m, i) {
  const { px, py, vx, vy, team, slot, err, cd, F, N } = m;
  const k = team[i], dir = dirOf(N, k);
  const bx = F[F_B], by = F[F_B + 1], gx = dir * HL;
  const dg = Math.sqrt((gx - bx) * (gx - bx) + by * by);
  const r1 = rf(m, i, 1), r2 = rf(m, i, 2), r3 = rf(m, i, 3);
  let tgx = gx, tgy = by * 0.6, spd = 2.5 + r2, vz = 0, shot = false, j = -1; // ドリブルは足元に近い軽い蹴り出し
  if (slot[i] === 0) {
    tgx = bx + dir * 30; tgy = (r2 - 0.5) * 40; spd = 22; vz = 8; // GK: 大きく蹴り出す
  } else if (dg < 22 && r1 < 0.12) {
    tgy = (r2 * 2 - 1) * GOAL_HW * 1.1; spd = 24 + 6 * r3; vz = 1 + 4 * rf(m, i, 4); shot = true; // シュート
  } else if (r1 < 0.6 && (j = pickMate(m, i, dir, r2)) >= 0) {
    tgx = px[j] + vx[j] * 0.6; tgy = py[j] + vy[j] * 0.6; // パス
    const ddx = tgx - bx, ddy = tgy - by;
    spd = clamp(Math.sqrt(ddx * ddx + ddy * ddy) * 1.2 + 8, 10, 24);
  } // それ以外はドリブル（前へ軽く蹴り出す）
  const ex = tgx - bx, ey = tgy - by, dist = Math.sqrt(ex * ex + ey * ey);
  const sig = err[i] * (shot ? 1.5 : clamp(dist / 25, 0.2, 1));
  const a = atan2(ey, ex) + normal4(m.seed, m.t, i, 7) * sig; // 蹴る向きの誤差
  F[F_B + 3] = cos(a) * spd;
  F[F_B + 4] = sin(a) * spd;
  F[F_B + 5] = vz;
  cd[i] = 10;
  N[I.LAST] = i;
  if (shot) { N[I.SHOTS + k]++; m.log.push([m.t, EV.SHOT, k, i]); }
}
