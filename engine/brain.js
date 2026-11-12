// 判断AIの「チーム」「認識」層（陣形・役割・動き）と、選手の移動、ボールとの接触（コントロール・タックル・セーブ）。
// 役割は N（N_ACT=役割、N_TGT=相手、N_TMR=タイマー）、目標は F（tx,ty,pc）に持つので、保存と復元ができる。
// 役割の割り当ては8tickごと（状況が変わったときはすぐ）、目標の更新は毎tick。
import {
  NP, DT, HL, HW, GOAL_HW, BALL_R, PHASE, NEXT, F_B, F_R, F_PASS, F_SB, I, ACT, ST, ST_N, EV, PRED_N, dirOf,
} from './consts.js';
import { AB, NAB } from './abil.js';
import { ROLE } from '../data/formations.js';
import { BALL_EV } from './ball.js';
import { normal4, f4 } from './core/rng.js';
import { atan2, cos, sin, exp, clamp } from './core/math.js';
import { xt, passV0, timeToCover, K_ROLL, R_CTRL, REACT_BASE } from './geom.js';
import { pressureAt, offsideLine, laneSafe, reactTicks } from './decide.js';

const REPLAN = 8, REACT = REACT_BASE; // REACT: 守備側がボールの動きを読んで反応し始めるまでの時間（秒）
// 役割ごとに、ボールの位置に合わせて陣形がどれだけ前後するか（攻撃時／守備時）。順は G C S D M W A F
const KX_ATT = [0, 0.5, 0.8, 0.85, 1, 1, 1, 1];
const KX_DEF = [0, 0.95, 0.95, 1, 1, 1, 0.9, 0.65];
const PRESS_BIAS = [1, 1.7, 1.15, 0.95, 1, 1.05, 1.1, 1.25]; // プレスに行きやすさ（小さいほど行く）
const UR = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];
const CH = [-0.65, -0.33, 0, 0.33, 0.65]; // 裏へ抜ける動きの横位置（ピッチ幅に対する割合）

// 自由なボールの軌道を0.25秒刻みで予測し、各選手が触れる最も早い時刻と場所を求める
function predictBall(m) {
  const { F, N, px, py, vmax, acc, ab, team, bpx, bpy, bpz, icT, icX, icY } = m;
  const x0 = F[F_B], y0 = F[F_B + 1], z0 = F[F_B + 2], vx0 = F[F_B + 3], vy0 = F[F_B + 4], vz0 = F[F_B + 5];
  for (let s = 1; s <= PRED_N; s++) {
    const tt = s * 0.25, g = (1 - exp(-K_ROLL * tt)) / K_ROLL, z = z0 + vz0 * tt - 4.9 * tt * tt;
    bpx[s] = clamp(x0 + vx0 * g, -HL, HL); bpy[s] = clamp(y0 + vy0 * g, -HW, HW); bpz[s] = z < BALL_R ? BALL_R : z;
  }
  // 触れる時刻 = 反応の遅れ + 走る時間（加速を考える）。パスを出した側は動きを知っているので遅れが小さい。
  const el = (m.t - N[I.KICKT]) * DT, pk = N[I.RECV] >= 0 ? N[I.PASSK] : -1;
  for (let i = 0; i < NP; i++) {
    icT[i] = 99;
    const rs = (team[i] === pk ? 0.1 : REACT_BASE - 0.1 + 0.02 * (20 - ab[i * NAB + AB.ANT])) - el;
    if (rs > 0) continue; // まだ反応していない
    for (let s = 1; s <= PRED_N; s++) {
      if (bpz[s] > 1.8) continue;
      const dx = bpx[s] - px[i], dy = bpy[s] - py[i];
      if (timeToCover(Math.sqrt(dx * dx + dy * dy) - R_CTRL, vmax[i], acc[i]) <= s * 0.25 - Math.min(0, rs)) { icT[i] = s * 0.25; icX[i] = bpx[s]; icY[i] = bpy[s]; break; }
    }
  }
}

// ボール保持者(cpx,cpy)へのサポート位置: 保持者の周り（7/12/17m × 8方向）から、パスコースが空いていて、
// 相手に離れていて、前へ進めて、持ち場から遠すぎず、味方と重ならない場所を選ぶ。
function supportSpot(m, k, i, dir, cpx, cpy, line) {
  const { px, py, tx, ty, hx, hy } = m;
  const o0 = (1 - k) * 11, j0 = k * 11;
  let best = -1e9, bx = tx[i], by = ty[i];
  for (let ri = 0; ri < 3; ri++) {
    const r = ri === 0 ? 7 : ri === 1 ? 12 : 17, v0 = passV0(r);
    for (let u = 0; u < 8; u++) {
      const wx = cpx + UR[u][0] * r * dir, wy = cpy + UR[u][1] * r * dir;
      if (Math.abs(wy) > HW - 2 || Math.abs(wx) > HL - 2) continue;
      const f = wx * dir;
      if (f > line - 0.5) continue; // オフサイドの位置には立たない
      const safe = laneSafe(m, k, cpx, cpy, wx, wy, v0);
      let dm = 1e9;
      for (let q = o0; q < o0 + 11; q++) { const dx = px[q] - wx, dy = py[q] - wy, d2 = dx * dx + dy * dy; if (d2 < dm) dm = d2; }
      const open = clamp((Math.sqrt(dm) - 1.5) / 5, 0, 1);
      let sc = safe * (0.3 + 0.7 * open) * (0.02 + xt(f, wy * dir)) * 10;
      const hdx = wx - hx[i], hdy = wy - hy[i], cdx = wx - tx[i], cdy = wy - ty[i];
      sc -= 0.04 * Math.sqrt(hdx * hdx + hdy * hdy) + 0.02 * Math.abs(r - 11) + 0.015 * Math.sqrt(cdx * cdx + cdy * cdy);
      for (let jj = j0 + 1; jj < j0 + 11; jj++) {
        if (jj === i) continue;
        const ax = wx - tx[jj], ay = wy - ty[jj], d2 = ax * ax + ay * ay;
        if (d2 < 49) sc -= 0.35 * (1 - Math.sqrt(d2) / 7);
      }
      if (sc > best) { best = sc; bx = wx; by = wy; }
    }
  }
  tx[i] = bx; ty[i] = by;
}

// 裏へ抜ける動き: 相手の最終ラインの肩（ライン-1m）か少し下がった位置のうち、保持者からのコースが空いている横位置へ
function runSpot(m, k, i, dir, cpx, cpy, line) {
  const { px, py, tx, ty, hx, hy } = m;
  const o0 = (1 - k) * 11, j0 = k * 11;
  let best = -1e9, bx = tx[i], by = ty[i];
  for (let ci = 0; ci < 5; ci++) {
    for (let di = 0; di < 2; di++) {
      const f = line - (di === 0 ? 1 : 6.5), g = CH[ci] * HW, wx = f * dir, wy = g * dir;
      const ex = wx - cpx, ey = wy - cpy, D = Math.sqrt(ex * ex + ey * ey);
      const safe = D > 45 ? 0.3 : laneSafe(m, k, cpx, cpy, wx, wy, passV0(D));
      let dm = 1e9;
      for (let q = o0; q < o0 + 11; q++) { const dx = px[q] - wx, dy = py[q] - wy, d2 = dx * dx + dy * dy; if (d2 < dm) dm = d2; }
      const open = clamp((Math.sqrt(dm) - 1.5) / 5, 0, 1);
      let sc = safe * (0.3 + 0.7 * open) * (0.02 + xt(f, g)) * 10 + (di === 0 ? 0.12 : 0);
      const hdx = wx - hx[i], hdy = wy - hy[i], cdx = wx - tx[i], cdy = wy - ty[i];
      sc -= 0.015 * Math.sqrt(hdx * hdx + hdy * hdy) + 0.015 * Math.sqrt(cdx * cdx + cdy * cdy);
      for (let jj = j0 + 1; jj < j0 + 11; jj++) {
        if (jj === i) continue;
        const ax = wx - tx[jj], ay = wy - ty[jj], d2 = ax * ax + ay * ay;
        if (d2 < 64) sc -= 0.35 * (1 - Math.sqrt(d2) / 8);
      }
      if (sc > best) { best = sc; bx = wx; by = wy; }
    }
  }
  tx[i] = bx; ty[i] = by;
}

// 自由なボール（パスの途中・こぼれ球）: 受け手、または触れるのが早い選手が追う
function assignChase(m, k, att, recv, bfx, bfy) {
  const { N, team, act, icT } = m, j0 = k * 11;
  if (att && recv >= 0 && team[recv] === k) { act[recv] = ACT.RECV; return; }
  if (N[I.LOCK] > 0 && N[I.LOCKT] !== k) return; // 再開の直後は、ボールを蹴る側だけが取りに行く
  const inBox = bfx < -HL + 17 && Math.abs(bfy) < 20.5;
  let a = -1, b = -1, ta = 99, tb = 99;
  for (let s = 0; s < 11; s++) {
    if (s === 0 && !inBox) continue;
    const i = j0 + s;
    if (act[i] !== ACT.HOME) continue;
    const tt = icT[i];
    if (tt < ta) { b = a; tb = ta; a = i; ta = tt; } else if (tt < tb) { b = i; tb = tt; }
  }
  const lim = !att && recv >= 0 ? Math.min(3.5, icT[recv] + 0.3) : 3.5; // パスを狙う側は、受け手より先に触れるときだけ
  if (a >= 0 && ta < lim) act[a] = ACT.CHASE;
  if (b >= 0 && tb < lim) act[b] = ACT.CHASE;
}

// 攻撃: 保持者(c)に近い3人がサポート、前線の2人が裏へ抜ける動き。残りは動的な陣形（持ち場）
function assignAttack(m, k, dir, c, cpx, cpy, bfx, line) {
  const { px, py, role, ab, act } = m, j0 = k * 11;
  for (let n = 0; n < 3; n++) {
    let a = -1, ta = 28 * 28;
    for (let s = 1; s < 11; s++) {
      const i = j0 + s;
      if (act[i] !== ACT.HOME || i === c) continue;
      if (role[i] === ROLE.C && bfx > 5) continue; // 最終ラインのCBは残る
      const dx = px[i] - cpx, dy = py[i] - cpy, d2 = dx * dx + dy * dy;
      if (d2 < ta) { ta = d2; a = i; }
    }
    if (a < 0) break;
    act[a] = ACT.SUPPORT;
    supportSpot(m, k, a, dir, cpx, cpy, line);
  }
  if (c >= 0 && cpx * dir > -25) {
    for (let n = 0; n < 2; n++) {
      let a = -1, ba = -1e9;
      for (let s = 1; s < 11; s++) {
        const i = j0 + s, r = role[i];
        if (act[i] !== ACT.HOME || i === c) continue;
        if (r !== ROLE.F && r !== ROLE.W && r !== ROLE.A) continue;
        if (px[i] * dir < bfx - 6) continue; // ボールよりだいぶ後ろの選手は走らない
        const dx = px[i] - cpx, dy = py[i] - cpy, d = Math.sqrt(dx * dx + dy * dy);
        if (d > 45) continue;
        const sc = ab[i * NAB + AB.OFF] + 0.5 * ab[i * NAB + AB.SPD] - 0.12 * d;
        if (sc > ba) { ba = sc; a = i; }
      }
      if (a < 0) break;
      act[a] = ACT.RUN;
      runSpot(m, k, a, dir, cpx, cpy, line);
    }
  }
}

// 守備: ボールに近い1人がプレス、次の1人がカバー、残りは近くの相手をマーク（マークする相手がいなければ持ち場）
function assignDefense(m, k, dir, bx, by, own) {
  const { px, py, vmax, role, act, tgt, pa, hx, hy, mpi, mpo, mpd, usedO } = m;
  const j0 = k * 11, o0 = (1 - k) * 11;
  let a = -1, b = -1, ta = 1e9, tb = 1e9;
  for (let s = 1; s < 11; s++) {
    const i = j0 + s;
    if (act[i] !== ACT.HOME) continue;
    const dx = bx - px[i], dy = by - py[i], d = Math.sqrt(dx * dx + dy * dy);
    if (d > 32) continue;
    let tt = (d / vmax[i]) * PRESS_BIAS[role[i]];
    if (pa[i] === ACT.PRESS) tt *= 0.8; // 役割がころころ変わらないように
    if (tt < ta) { b = a; tb = ta; a = i; ta = tt; } else if (tt < tb) { b = i; tb = tt; }
  }
  if (a >= 0) act[a] = ACT.PRESS;
  if (b >= 0 && tb < 5) { act[b] = ACT.COVER; tgt[b] = a; }
  let n = 0;
  for (let s = 1; s < 11; s++) {
    const i = j0 + s;
    if (act[i] !== ACT.HOME) continue;
    for (let q = o0 + 1; q < o0 + 11; q++) {
      if (q === own) continue;
      const dx = px[q] - hx[i], dy = py[q] - hy[i], d2 = dx * dx + dy * dy;
      if (d2 < 196 && n < 128) { mpi[n] = i; mpo[n] = q; mpd[n] = d2; n++; }
    }
  }
  for (let u = 1; u < n; u++) { // 近い順に並べる（挿入ソート）
    const ci = mpi[u], co = mpo[u], cd = mpd[u];
    let w = u - 1;
    while (w >= 0 && mpd[w] > cd) { mpi[w + 1] = mpi[w]; mpo[w + 1] = mpo[w]; mpd[w + 1] = mpd[w]; w--; }
    mpi[w + 1] = ci; mpo[w + 1] = co; mpd[w + 1] = cd;
  }
  usedO.fill(0);
  for (let u = 0; u < n; u++) {
    const i = mpi[u], q = mpo[u];
    if (act[i] !== ACT.HOME || usedO[q]) continue;
    act[i] = ACT.MARK; m.tgt[i] = q; usedO[q] = 1;
  }
}

// GK: 通常はゴール中央とボールを結ぶ線上。ボールが自ゴールへ向かっているときは、通過点へ飛ぶ。
function planGK(m, k, dir, own, att, bfx, bfy) {
  const { F, N, tx, ty, pc, act, ab, icT, icX, icY } = m, i = k * 11;
  if (i === own) return;
  if (act[i] === ACT.CHASE || act[i] === ACT.RECV) {
    if (icT[i] < 99) { tx[i] = icX[i]; ty[i] = icY[i]; } else { tx[i] = F[F_B]; ty[i] = F[F_B + 1]; }
    pc[i] = 1;
    return;
  }
  const dgx = bfx + HL, dg = Math.sqrt(dgx * dgx + bfy * bfy) + 1e-6;
  const gkd = att ? clamp(0.1 * dg, 2, 13) : clamp(0.12 * dg + 0.8, 1.2, 7);
  let fx = -HL + (dgx / dg) * gkd, fy = clamp((bfy / dg) * gkd, -GOAL_HW - 2, GOAL_HW + 2);
  pc[i] = 0.5;
  if (own < 0 && N[I.PHASE] === PHASE.LIVE) {
    const bvx = F[F_B + 3] * dir, bvy = F[F_B + 4] * dir;
    if (bvx < -5) {
      const tc = ((F[F_B] * dir + HL) / -bvx) * 1.15, yc = F[F_B + 1] * dir + bvy * tc * 0.85;
      const react = 4 + 0.55 * (20 - ab[i * NAB + AB.GKR]);
      const seen = N[I.SHOTK] !== 1 - k || m.t - N[I.SHOTT] >= react; // 撃たれてから反応するまでの遅れ
      if (seen && tc < 1.8 && Math.abs(yc) < GOAL_HW + 3) { fx = -HL + 0.8; fy = clamp(yc, -GOAL_HW - 1, GOAL_HW + 1); pc[i] = 1; }
    }
  }
  tx[i] = fx * dir; ty[i] = fy * dir;
}

// 役割に応じて、毎tickの目標位置と走る強さを決める
function applyTargets(m, k, dir, att, own, bx, by, bfx, bfy) {
  const { F, px, py, tx, ty, pc, act, tgt, tmr, hx, hy, icT, icX, icY, ab } = m;
  const j0 = k * 11, gx = -dir * HL;
  planGK(m, k, dir, own, att, bfx, bfy);
  for (let s = 1; s < 11; s++) {
    const i = j0 + s;
    if (i === own) continue;
    switch (act[i]) {
      case ACT.PRESS: { // 間合いを保って寄せる: ボールの少し先から、自ゴール側へ jd だけ離れた点に立つ（突っ込まない）
        const jd = 2.6 - 0.05 * ab[i * NAB + AB.AGG];
        const ex = bx + F[F_B + 3] * 0.4, ey = by + F[F_B + 4] * 0.4;
        let ux = gx - ex, uy = -ey, L = Math.sqrt(ux * ux + uy * uy);
        if (L < 1e-6) L = 1;
        tx[i] = ex + (ux / L) * jd; ty[i] = ey + (uy / L) * jd;
        const dx = bx - px[i], dy = by - py[i];
        pc[i] = dx * dx + dy * dy > 64 ? 1 : 0.7; // 遠いときだけ全力
        break;
      }
      case ACT.COVER: {
        const a = tgt[i];
        if (a >= 0 && act[a] === ACT.PRESS) {
          let ux = gx - bx, uy = -by, L = Math.sqrt(ux * ux + uy * uy);
          if (L < 1e-6) L = 1;
          tx[i] = bx + (ux / L) * 6; ty[i] = by + (uy / L) * 6; pc[i] = 0.65;
        } else { act[i] = ACT.HOME; tx[i] = hx[i]; ty[i] = hy[i]; pc[i] = 0.5; }
        break;
      }
      case ACT.MARK: {
        const q = tgt[i], ox = px[q], oy = py[q];
        const ux = gx - ox, uy = -oy, L = Math.sqrt(ux * ux + uy * uy) || 1;
        const wx = bx - ox, wy = by - oy, L2 = Math.sqrt(wx * wx + wy * wy) || 1;
        const gs = L2 < 12 ? 2 : L2 < 25 ? 3.5 : 5; // ボールから遠い相手ほど、ゆるく（深めに）見る
        let mx = ox + (ux / L) * gs + (wx / L2) * 0.8, my = oy + (uy / L) * gs + (wy / L2) * 0.8; // 相手のゴール側に立つ
        const ddx = mx - hx[i], ddy = my - hy[i];
        if (ddx * ddx + ddy * ddy > 400) { mx = hx[i]; my = hy[i]; } // 持ち場から離れすぎるときは持ち場へ
        tx[i] = clamp(mx, -HL, HL); ty[i] = clamp(my, -HW, HW); pc[i] = 0.5;
        break;
      }
      case ACT.SUPPORT: pc[i] = 0.55; break;
      case ACT.RUN: pc[i] = 0.9; break;
      case ACT.RECV:
        if (icT[i] < 99) { tx[i] = icX[i]; ty[i] = icY[i]; } else { tx[i] = F[F_PASS]; ty[i] = F[F_PASS + 1]; }
        pc[i] = 1;
        break;
      case ACT.CHASE:
        if (icT[i] < 99) { tx[i] = icX[i]; ty[i] = icY[i]; } else { tx[i] = bx; ty[i] = by; }
        pc[i] = 1;
        break;
      case ACT.FOLLOW:
        if (tmr[i] <= 0 || !att) { act[i] = ACT.HOME; tx[i] = hx[i]; ty[i] = hy[i]; pc[i] = 0.5; } else {
          tx[i] = clamp(bx + dir * 8, -HL + 3, HL - 3); ty[i] = clamp(by * 0.5, -HW + 2, HW - 2); pc[i] = 0.65;
        }
        break;
      default: {
        tx[i] = hx[i]; ty[i] = hy[i];
        const dx = hx[i] - px[i], dy = hy[i] - py[i];
        pc[i] = dx * dx + dy * dy > 144 ? 0.65 : 0.45;
      }
    }
  }
}

function planTeam(m, k, P, own, live) {
  const { F, N, px, py, team, role, fd, fl, act, tgt, tmr, hx, hy, pa } = m;
  const dir = dirOf(N, k), att = P === k, j0 = k * 11;
  const loose = live && own < 0, recv = loose ? N[I.RECV] : -1;
  let bx = F[F_B], by = F[F_B + 1];
  if (!live) {
    if (N[I.NEXT] === NEXT.RESTART) { bx = F[F_R]; by = F[F_R + 1]; } else { bx = 0; by = 0; }
  } else if (loose) {
    if (!att && (m.t - N[I.KICKT]) * DT < REACT) { /* 守備側はまだ反応前: 蹴られたボールの行き先を読めない */ }
    else if (recv >= 0) { bx = F[F_PASS]; by = F[F_PASS + 1]; } else { bx += F[F_B + 3] * 0.6; by += F[F_B + 4] * 0.6; }
  }
  bx = clamp(bx, -HL, HL); by = clamp(by, -HW, HW);
  // 陣形の基準は、ボールの位置そのものではなく「ならした位置」（ボールにゆっくり追従。チームは一斉に行ったり来たりしない）
  const SB = F_SB + 2 * k;
  if (!live) { F[SB] = bx; F[SB + 1] = by; } else {
    const lim = 4.5 * DT;
    F[SB] += clamp(bx - F[SB], -lim, lim); F[SB + 1] += clamp(by - F[SB + 1], -lim, lim);
  }
  const bfx = bx * dir, bfy = by * dir, sfx = F[SB] * dir, sfy = F[SB + 1] * dir, line = offsideLine(m, k), cx0 = m.cx0[k];

  // 動的な持ち場: 陣形を基準に、ボールの位置・攻守に合わせて前後左右に動かし、縦を詰める
  const compr = att ? 0.92 : 0.78;
  const shiftA = clamp(0.6 * (sfx - cx0) + 8, -8, 24), shiftD = clamp(0.55 * (sfx - cx0) - 2, -22, 8);
  for (let s = 1; s < 11; s++) {
    const i = j0 + s, r = role[i];
    let f = cx0 + (-HL + fd[i] * 2 * HL - cx0) * compr + (att ? shiftA * KX_ATT[r] : shiftD * KX_DEF[r]);
    let g = fl[i] * HW * 0.9 * (att ? (r === ROLE.W || r === ROLE.S ? 1.05 : 0.96) : 0.8);
    g = clamp(g + (sfy - g) * (att ? 0.12 : 0.42), -HW + 2, HW - 2);
    if (att && r >= ROLE.M) f = Math.min(f, line - 0.7); // 攻撃の選手は最終ラインを越えない
    f = clamp(f, -HL + 4, HL - 3);
    hx[i] = f * dir; hy[i] = g * dir;
  }

  // 役割の割り当て（8tickごと。ボールの状況が変わったときはすぐ）
  const key = (P + 1) + 4 * (loose ? 1 : 0) + 8 * (recv >= 0 ? 1 : 0) + 16 * (N[I.LOCK] > 0 ? 1 : 0) + 32 * (live ? 1 : 0);
  const replan = (m.t + (loose ? k : 4 * k)) % (loose ? 2 : REPLAN) === 0 || N[I.PLANK + k] !== key;
  N[I.PLANK + k] = key;
  if (replan) {
    if (j0 !== own) act[j0] = ACT.HOME;
    for (let s = 1; s < 11; s++) {
      const i = j0 + s;
      pa[i] = act[i];
      if (i === own) continue;
      if (act[i] === ACT.FOLLOW && tmr[i] > 0 && att) continue;
      act[i] = ACT.HOME; tgt[i] = -1;
    }
    if (loose) assignChase(m, k, att, recv, bfx, bfy);
    if (att) {
      const c = own >= 0 ? own : (recv >= 0 && team[recv] === k ? recv : -1);
      assignAttack(m, k, dir, c, c >= 0 ? px[c] : bx, c >= 0 ? py[c] : by, bfx, line);
    } else assignDefense(m, k, dir, bx, by, own);
  }
  applyTargets(m, k, dir, att, own, bx, by, bfx, bfy);
}

// 全員の役割と目標を更新する
export function think(m) {
  const N = m.N, live = N[I.PHASE] === PHASE.LIVE, own = live ? N[I.OWN] : -1;
  const P = own >= 0 ? m.team[own] : N[I.POSS];
  if (live && own < 0) predictBall(m);
  for (let k = 0; k < 2; k++) planTeam(m, k, P, own, live);
}

// 目標へ向かって、最高速度（×走る強さ）と加速度の範囲で動く。重なった選手は少し離す。
export function movePlayers(m) {
  const { px, py, vx, vy, tx, ty, pc, vmax, acc, slot } = m;
  for (let i = 0; i < NP; i++) {
    const dx = tx[i] - px[i], dy = ty[i] - py[i], d = Math.sqrt(dx * dx + dy * dy), cap = vmax[i] * pc[i];
    let wx = 0, wy = 0;
    const a = m.act[i], urgent = a === ACT.PRESS || a === ACT.CHASE || a === ACT.RECV || a === ACT.CARRY || a === ACT.RUN || slot[i] === 0;
    const dz = urgent ? 0.4 : 1.2; // 目標の近くでは止まる（持ち場や間合いの細かい修正で走り回らない）
    if (d > dz) { // 近づくほど減速（寄せる・追う役は反応を速く）
      const s = Math.min(cap, (d - dz) * (urgent ? 2.6 : 1.5)) / d; wx = dx * s; wy = dy * s;
    }
    let ax = wx - vx[i], ay = wy - vy[i];
    const lim = acc[i] * (slot[i] === 0 ? (pc[i] >= 1 ? 3 : 2) : 1) * DT, da = Math.sqrt(ax * ax + ay * ay);
    if (da > lim) { const s = lim / da; ax *= s; ay *= s; }
    vx[i] += ax; vy[i] += ay;
    px[i] = clamp(px[i] + vx[i] * DT, -HL - 2, HL + 2);
    py[i] = clamp(py[i] + vy[i] * DT, -HW - 2, HW + 2);
  }
  for (let i = 0; i < NP; i++) {
    for (let j = i + 1; j < NP; j++) {
      const dx = px[j] - px[i], dy = py[j] - py[i], d2 = dx * dx + dy * dy;
      if (d2 < 0.49 && d2 > 1e-9) {
        const d = Math.sqrt(d2), s = (0.7 - d) / (2 * d);
        px[i] -= dx * s; py[i] -= dy * s; px[j] += dx * s; py[j] += dy * s;
      }
    }
  }
}

// ボールを持っている間は、足元（進む向きに0.45m）に付いてくる。ライン越えの判定もここで行う。
export function carryBall(m) {
  const { F, N, px, py, vx, vy, tx, ty, team } = m, o = N[I.OWN];
  let dx = tx[o] - px[o], dy = ty[o] - py[o], d = Math.sqrt(dx * dx + dy * dy);
  if (d < 0.5) { dx = dirOf(N, team[o]); dy = 0; d = 1; } // 止まっているときは相手ゴールの向き
  const gx = px[o] + (dx / d) * 0.45, gy = py[o] + (dy / d) * 0.45;
  F[F_B + 6] = F[F_B]; F[F_B + 7] = F[F_B + 1];
  F[F_B] = gx; F[F_B + 1] = gy; F[F_B + 2] = BALL_R;
  F[F_B + 3] = vx[o]; F[F_B + 4] = vy[o]; F[F_B + 5] = 0;
  if (gx > HL) return Math.abs(gy) < GOAL_HW ? BALL_EV.GOAL_PX : BALL_EV.OUT_PX;
  if (gx < -HL) return Math.abs(gy) < GOAL_HW ? BALL_EV.GOAL_NX : BALL_EV.OUT_NX;
  if (gy > HW) return BALL_EV.OUT_PY;
  if (gy < -HW) return BALL_EV.OUT_NY;
  return BALL_EV.NONE;
}

// 選手 p がボールをコントロールした
export function takeControl(m, p) {
  const { F, N, team, slot, px, py, vx, vy, tx, ty, pc, act, tgt, tmr } = m;
  const k = team[p], pk = N[I.PASSK];
  if (pk >= 0) N[I.ST + k * ST_N + (pk === k ? ST.PASSOK : ST.ICPT)]++; // パス成功か、相手に奪われたか
  N[I.PASSK] = -1; N[I.OWN] = p; N[I.POSS] = k; N[I.LAST] = p; N[I.RECV] = -1; N[I.SHOTK] = -1;
  act[p] = ACT.CARRY; tgt[p] = -1;
  tmr[p] = reactTicks(m, p, pressureAt(m, px[p], py[p], k)) + (slot[p] === 0 ? 30 : 0); // GKは持ってから少し間を取る
  tx[p] = px[p] + vx[p] * 0.3; ty[p] = py[p] + vy[p] * 0.3; pc[p] = 0.5;
  F[F_B + 3] = vx[p]; F[F_B + 4] = vy[p]; F[F_B + 5] = 0;
}

// GKがボールに触れた: 遅い・低いボールはキャッチ、速いボールははじく
function keeperTouch(m, p, vb) {
  const { F, N, team, ab, t, seed } = m, k = team[p], dir = dirOf(N, k);
  const shotOn = N[I.SHOTK] === 1 - k && t - N[I.SHOTT] < 100;
  const lim = 11 + ab[p * NAB + AB.GKC] + 2 * normal4(seed, t, p, 62);
  if (shotOn) { N[I.ST + k * ST_N + ST.SAVE]++; m.log.push([t, EV.SAVE, k, p]); N[I.SHOTK] = -1; }
  if (vb <= lim && F[F_B + 2] < 2.4) { takeControl(m, p); return; }
  const a = atan2(0, dir) + normal4(seed, t, p, 63) * 0.9, v = 2 + 0.4 * vb; // フィールドの側へ、ばらつきながらはじく
  F[F_B + 3] = cos(a) * v; F[F_B + 4] = sin(a) * v; F[F_B + 5] = 1.5;
  N[I.LAST] = p; N[I.KICKT] = t; m.cd[p] = 8; N[I.PASSK] = -1; N[I.RECV] = -1;
}

// 選手 p が自由なボールに触れた: 速すぎる・圧力が強いと、ファーストタッチが乱れてボールが弾む
function onTouch(m, p) {
  const { F, N, team, slot, ab, px, py, t, seed } = m, k = team[p], A = p * NAB;
  const vb = Math.sqrt(F[F_B + 3] * F[F_B + 3] + F[F_B + 4] * F[F_B + 4]);
  if (slot[p] === 0) { keeperTouch(m, p, vb); return; }
  const press = pressureAt(m, px[p], py[p], k);
  const bz = F[F_B + 2], air = bz > 0.9 ? 1.5 * (bz - 0.9) + (bz > 1.4 ? 1 : 0) : 0; // 浮いたボールは難しい（ヘディング・胸）
  const q = 3 + 0.8 * ab[A + AB.TRP] + 0.2 * ab[A + AB.CMP] + (bz > 1.4 ? 0.2 * ab[A + AB.HED] : 0) - 0.3 * vb - 5 * press - air + 2.5 * normal4(seed, t, p, 60);
  if (q >= 0) { takeControl(m, p); return; }
  const a = atan2(F[F_B + 4], F[F_B + 3]) + normal4(seed, t, p, 61), v = Math.max(2, vb * 0.45);
  F[F_B + 3] = cos(a) * v; F[F_B + 4] = sin(a) * v; F[F_B + 5] = 1.5;
  N[I.LAST] = p; N[I.KICKT] = t; m.cd[p] = 8; N[I.PASSK] = -1; N[I.RECV] = -1;
  N[I.ST + k * ST_N + ST.MISC]++;
}

// 前tick→今tickのボールの軌跡に一番近づいた選手が触る
function looseTouch(m) {
  const { px, py, team, slot, cd, rgk, F, N } = m;
  const ax = F[F_B + 6], ay = F[F_B + 7], bx = F[F_B], by = F[F_B + 1], bz = F[F_B + 2];
  const ex = bx - ax, ey = by - ay, ee = ex * ex + ey * ey;
  const lock = N[I.LOCK] > 0 ? N[I.LOCKT] : -1;
  let best = -1, bd = 1e18;
  for (let i = 0; i < NP; i++) {
    if (cd[i] > 0 || (lock >= 0 && team[i] !== lock)) continue;
    const gk = slot[i] === 0;
    if (bz > (gk ? 2.5 : 2.0)) continue; // 頭・胸で受けられる高さまで
    let s = ee > 1e-9 ? ((px[i] - ax) * ex + (py[i] - ay) * ey) / ee : 1;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    const dx = ax + ex * s - px[i], dy = ay + ey * s - py[i], d2 = dx * dx + dy * dy, rr = gk ? rgk[i] : R_CTRL;
    if (d2 < rr * rr && d2 < bd) { bd = d2; best = i; }
  }
  if (best >= 0) onTouch(m, best);
}

// ボール保持者 o に、相手が足を出す。奪えるか（きれいに奪う／こぼれる／かわされる）は両者の能力と、
// 足が届く位置関係（保持者の体が間にあると届きにくい）で決まる。
function tackles(m, o) {
  const { F, N, px, py, vx, vy, team, cd, ab, t, seed } = m;
  const k = team[o], j0 = (1 - k) * 11, bx = F[F_B], by = F[F_B + 1];
  let best = -1, bd = 1e9;
  for (let j = j0 + 1; j < j0 + 11; j++) {
    if (cd[j] > 0) continue;
    let reach = 0.75 + 0.012 * ab[j * NAB + AB.TCK];
    if ((px[j] - px[o]) * (bx - px[o]) + (py[j] - py[o]) * (by - py[o]) < 0) reach *= 0.55;
    const dx = px[j] - bx, dy = py[j] - by, d = Math.sqrt(dx * dx + dy * dy);
    if (d < reach && d < bd) { bd = d; best = j; }
  }
  if (best < 0) return;
  const j = best, kj = 1 - k, A = o * NAB, B = j * NAB;
  const rx = px[o] - px[j], ry = py[o] - py[j], dd = Math.sqrt(rx * rx + ry * ry);
  const cs = dd > 0.01 ? ((vx[j] - vx[o]) * rx + (vy[j] - vy[o]) * ry) / dd : 0; // 寄せる速さ
  const qd = 0.6 * ab[B + AB.TCK] + 0.3 * ab[B + AB.AGG] + 0.4 * clamp(cs, 0, 5);
  const qc = 0.6 * ab[A + AB.DRI] + 0.25 * ab[A + AB.BAL] + 0.15 * ab[A + AB.STR];
  if (f4(seed, t, j, 66) >= 0.05 + 0.004 * ab[B + AB.AGG]) return; // 間合いに入っても、毎tick足を出すわけではない
  const mg = qd - qc + 2.2 * normal4(seed, t, j, 64) - 0.5;
  N[I.ST + kj * ST_N + ST.TKL]++;
  if (mg < 0) { cd[j] = mg < -4 ? 40 : 30; return; } // 取れない（大きく外すとかわされて遅れる）
  N[I.ST + kj * ST_N + ST.TKLW]++;
  cd[o] = 10;
  if (mg >= 3) { takeControl(m, j); return; } // きれいに奪う
  const a = atan2(by - py[j], bx - px[j]) + normal4(seed, t, j, 65) * 0.6, v = 2.5 + 0.1 * ab[B + AB.TCK];
  F[F_B + 3] = cos(a) * v; F[F_B + 4] = sin(a) * v; F[F_B + 5] = 0;
  F[F_B + 6] = bx; F[F_B + 7] = by;
  N[I.OWN] = -1; N[I.LAST] = j; N[I.KICKT] = t; cd[j] = 4;
}

export function touches(m) {
  const own = m.N[I.OWN];
  if (own >= 0) tackles(m, own); else looseTouch(m);
}
