// 試合エンジン本体。画面に依存しない純粋なJS。Worker でも Node でも動く。
// 状態は2つの型付き配列（F=小数、N=整数）と出来事の記録（log）だけ。保存・復元・比較が簡単になる。
// 時間は固定刻み（20Hz）の整数 tick。乱数は (試合の種, tick, 選手, 用途) から作るので、状態を持たない。
import {
  ENGINE_VERSION, DT, HALF_TICKS, FULL_TICKS, NP, HL, HW, BALL_R, PRED_N,
  F_PX, F_PY, F_VX, F_VY, F_TX, F_TY, F_PC, F_B, F_R, F_LEN,
  I, N_CD, N_ACT, N_TGT, N_TMR, N_LEN, PHASE, NEXT, EV, ACT, dirOf,
} from './consts.js';
import { FORMATIONS } from '../data/formations.js';
import { AB, NAB, abVec } from './abil.js';
import { stepBall, BALL_EV } from './ball.js';
import { think, movePlayers, carryBall, touches } from './brain.js';
import { decide } from './decide.js';
import { Digest } from './core/digest.js';
import { clamp } from './core/math.js';

// input = { seed, teams: [ { formation, players: [ { id, ab } x11 ] } x2 ], changes: [] }
// players の並びがスロット（0=GK）。ab は能力32個の配列（engine/abil.js の順）。数値なら全能力が同じ値。
// changes は後の段階で使う（交代・戦術変更）。
export function createMatch(input) {
  const F = new Float64Array(F_LEN), N = new Int32Array(N_LEN);
  const sub = (a, o) => a.subarray(o, o + NP);
  const m = {
    input, seed: input.seed | 0, t: 0, log: [], F, N,
    px: sub(F, F_PX), py: sub(F, F_PY), vx: sub(F, F_VX), vy: sub(F, F_VY), tx: sub(F, F_TX), ty: sub(F, F_TY), pc: sub(F, F_PC),
    cd: sub(N, N_CD), act: sub(N, N_ACT), tgt: sub(N, N_TGT), tmr: sub(N, N_TMR),
    // 入力から決まる値（状態ではない）
    team: new Uint8Array(NP), slot: new Uint8Array(NP), role: new Uint8Array(NP),
    fd: new Float64Array(NP), fl: new Float64Array(NP), // 持ち場（奥行・横）
    ab: new Float64Array(NP * NAB), vmax: new Float64Array(NP), acc: new Float64Array(NP), rgk: new Float64Array(NP),
    cx0: new Float64Array(2), kick: new Uint8Array(2),
    nb: new Int8Array(NP * 3).fill(-1), nw: new Float64Array(NP * 3), // 陣形上の隣（持ち場が近い3人）とその重み
    ord: new Int16Array(NP), done: new Uint8Array(NP), // 追従の計算用（作業用）
    // 毎tick作り直す作業用（状態ではない）
    hx: new Float64Array(NP), hy: new Float64Array(NP), icT: new Float64Array(NP), icX: new Float64Array(NP), icY: new Float64Array(NP),
    bpx: new Float64Array(PRED_N + 1), bpy: new Float64Array(PRED_N + 1), bpz: new Float64Array(PRED_N + 1),
    pa: new Uint8Array(NP), mpi: new Int16Array(128), mpo: new Int16Array(128), mpd: new Float64Array(128), usedO: new Uint8Array(NP),
  };
  for (let k = 0; k < 2; k++) {
    const T = input.teams[k], form = FORMATIONS[T.formation];
    let sx = 0, deepest = -1;
    for (let s = 0; s < 11; s++) {
      const i = k * 11 + s, v = abVec(T.players[s].ab);
      m.team[i] = k; m.slot[i] = s; m.role[i] = form[s][2];
      m.fd[i] = form[s][0]; m.fl[i] = form[s][1];
      m.ab.set(v, i * NAB);
      m.vmax[i] = 5.8 + 0.22 * v[AB.SPD]; // 最高速度 (m/s)
      m.acc[i] = 4 + 0.2 * v[AB.ACC]; // 加速度 (m/s²)
      m.rgk[i] = s === 0 ? 1.2 + 0.05 * v[AB.GKR] : 0; // GKの届く範囲 (m)
      if (s > 0) {
        sx += -HL + form[s][0] * 2 * HL;
        if (form[s][0] > deepest) { deepest = form[s][0]; m.kick[k] = s; } // キックオフで使う、最前線の選手
      }
    }
    m.cx0[k] = sx / 10; // 外野手の持ち場の平均（動的な陣形の基準）
    for (let s = 1; s < 11; s++) { // 持ち場が近い3人を「隣」にする（近いほど強く影響し合う）
      const i = k * 11 + s, xi = form[s][0] * 2 * HL, yi = form[s][1] * HW * 0.9;
      let c0 = -1, c1 = -1, c2 = -1, d0 = 1e9, d1 = 1e9, d2 = 1e9;
      for (let q = 1; q < 11; q++) {
        if (q === s) continue;
        const dx = form[q][0] * 2 * HL - xi, dy = form[q][1] * HW * 0.9 - yi, d = Math.sqrt(dx * dx + dy * dy);
        if (d < d0) { c2 = c1; d2 = d1; c1 = c0; d1 = d0; c0 = q; d0 = d; }
        else if (d < d1) { c2 = c1; d2 = d1; c1 = q; d1 = d; }
        else if (d < d2) { c2 = q; d2 = d; }
      }
      const cs = [c0, c1, c2], ds = [d0, d1, d2];
      for (let u = 0; u < 3; u++) { m.nb[i * 3 + u] = k * 11 + cs[u]; m.nw[i * 3 + u] = 1 / (1 + (ds[u] * ds[u]) / 196); }
    }
  }
  N[I.LAST] = -1;
  N[I.HALF] = 1;
  placeKickoff(m, 0);
  return m;
}

function placeKickoff(m, kteam) {
  const { F, N, px, py, vx, vy, tx, ty, pc, team, fd, fl, cd, act, tgt, tmr } = m;
  for (let i = 0; i < NP; i++) {
    const dir = dirOf(N, team[i]), d = Math.min(fd[i], 0.47);
    px[i] = tx[i] = dir * (d * 2 * HL - HL);
    py[i] = ty[i] = fl[i] * HW * 0.9 * dir;
    vx[i] = vy[i] = 0; cd[i] = 0; act[i] = ACT.HOME; tgt[i] = -1; tmr[i] = 0; pc[i] = 0.6;
  }
  const f = kteam * 11 + m.kick[kteam], dk = dirOf(N, kteam); // キックオフ側の最前線の選手をボールの後ろに置く
  px[f] = tx[f] = -dk * 0.5;
  py[f] = ty[f] = 0;
  F[F_B] = F[F_B + 1] = F[F_B + 3] = F[F_B + 4] = F[F_B + 5] = F[F_B + 6] = F[F_B + 7] = 0;
  F[F_B + 2] = BALL_R;
  N[I.LOCK] = 40; N[I.LOCKT] = kteam; N[I.PHASE] = PHASE.LIVE;
  N[I.OWN] = -1; N[I.RECV] = -1; N[I.PASSK] = -1; N[I.SHOTK] = -1; N[I.POSS] = kteam; N[I.KICKT] = m.t;
}

function pause(m, ticks, next, rteam) {
  const N = m.N;
  N[I.PHASE] = PHASE.PAUSE; N[I.TIMER] = ticks; N[I.NEXT] = next; N[I.RTEAM] = rteam;
  N[I.OWN] = -1; N[I.RECV] = -1; N[I.PASSK] = -1; N[I.SHOTK] = -1; N[I.POSS] = rteam;
}

function resume(m) {
  const { F, N } = m;
  if (N[I.NEXT] === NEXT.KICKOFF) { placeKickoff(m, N[I.RTEAM]); return; }
  F[F_B] = F[F_B + 6] = F[F_R];
  F[F_B + 1] = F[F_B + 7] = F[F_R + 1];
  F[F_B + 2] = BALL_R;
  F[F_B + 3] = F[F_B + 4] = F[F_B + 5] = 0;
  N[I.LOCK] = 30; N[I.LOCKT] = N[I.RTEAM]; N[I.PHASE] = PHASE.LIVE; N[I.KICKT] = m.t;
}

// ボールがゴールラインやタッチラインを越えた
function onBallEvent(m, ev) {
  const { F, N } = m;
  if (ev === BALL_EV.GOAL_PX || ev === BALL_EV.GOAL_NX) {
    const k = dirOf(N, 0) === (ev === BALL_EV.GOAL_PX ? 1 : -1) ? 0 : 1; // その向きに攻めているチームの得点
    N[I.SCORE + k]++;
    m.log.push([m.t, EV.GOAL, k, N[I.LAST]]);
    pause(m, 60, NEXT.KICKOFF, 1 - k);
    return;
  }
  const lk = N[I.LAST] >= 0 ? m.team[N[I.LAST]] : 0; // 最後に触ったチーム
  let rteam, rx, ry;
  if (ev === BALL_EV.OUT_PX || ev === BALL_EV.OUT_NX) {
    const sx = ev === BALL_EV.OUT_PX ? 1 : -1;
    const def = dirOf(N, 0) === -sx ? 0 : 1; // そのゴールを守るチーム
    if (lk === def) { rteam = 1 - def; rx = sx * (HL - 0.3); ry = F[F_B + 1] > 0 ? HW - 0.3 : -(HW - 0.3); } // コーナーキック
    else { rteam = def; rx = sx * (HL - 5.5); ry = 0; } // ゴールキック
  } else {
    rteam = 1 - lk; rx = clamp(F[F_B], -HL + 1, HL - 1); ry = ev === BALL_EV.OUT_PY ? HW - 0.2 : -(HW - 0.2); // スローイン
  }
  m.log.push([m.t, EV.OUT, ev, rteam]);
  F[F_R] = rx; F[F_R + 1] = ry;
  pause(m, 30, NEXT.RESTART, rteam);
}

// 1 tick 進める。終了済みなら false。
export function stepMatch(m) {
  const { F, N } = m, ph = N[I.PHASE];
  if (ph === PHASE.END) return false;
  think(m);
  movePlayers(m);
  if (ph === PHASE.LIVE) {
    let ev;
    if (N[I.OWN] >= 0) ev = carryBall(m);
    else { F[F_B + 6] = F[F_B]; F[F_B + 7] = F[F_B + 1]; ev = stepBall(F, F_B, DT); }
    if (ev !== BALL_EV.NONE) onBallEvent(m, ev); else touches(m);
    for (let i = 0; i < NP; i++) {
      if (N[N_CD + i] > 0) N[N_CD + i]--;
      if (N[N_TMR + i] > 0) N[N_TMR + i]--;
    }
    if (N[I.LOCK] > 0) N[I.LOCK]--;
    const o = N[I.OWN];
    if (o >= 0 && N[N_TMR + o] <= 0) decide(m, o); // 保持者が次の行動を決める
  } else if (--N[I.TIMER] <= 0) resume(m);
  m.t++;
  if (m.t === HALF_TICKS) {
    N[I.HALF] = 2;
    m.log.push([m.t, EV.HALF, N[I.SCORE], N[I.SCORE + 1]]);
    placeKickoff(m, 1);
  } else if (m.t >= FULL_TICKS) {
    N[I.PHASE] = PHASE.END;
    m.log.push([m.t, EV.FULL, N[I.SCORE], N[I.SCORE + 1]]);
  }
  return true;
}

// tick が until になるまで進める。stop = { [EV.GOAL]: true } のように渡すと、その出来事が起きた tick で止まり、
// その出来事 [t, 種類, a, b] を返す（止まらずに until / 終了まで進んだら null）。
export function run(m, until = FULL_TICKS, stop = null) {
  while (m.t < until && m.N[I.PHASE] !== PHASE.END) {
    const n0 = m.log.length;
    stepMatch(m);
    if (stop !== null) for (let j = n0; j < m.log.length; j++) if (stop[m.log[j][1]]) return m.log[j];
  }
  return null;
}

// 保存と復元（途中経過の保存、介入後の再計算の起点に使う）。入力(input)は含まない。
export function snapshot(m) {
  return { t: m.t, F: m.F.slice(), N: m.N.slice(), log: m.log.map((e) => e.slice()) };
}
export function restore(m, s) {
  m.t = s.t; m.F.set(s.F); m.N.set(s.N); m.log = s.log.map((e) => e.slice());
}
export function snapshotToJSON(s) {
  return { t: s.t, F: Array.from(s.F), N: Array.from(s.N), log: s.log };
}

// 状態のチェック値
export function digestMatch(m) {
  const d = new Digest().int(ENGINE_VERSION).int(m.t).nums(m.F).ints(m.N).int(m.log.length);
  for (const e of m.log) d.ints(e);
  return d.hex();
}

// 描画用の画面1コマぶん。描画側はエンジンの内部を見ず、これだけを受け取る（Worker から転送もしやすい形）。
// xy = 22人の x,y を交互に並べたもの（0〜10がチーム0、11〜21がチーム1）、ball = x,y,z（メートル）、
// own = ボールを持っている選手（いなければ -1）、act = 22人の今の役割（ACT）
// 表示用の役割。持ち場にいて、隣に合わせて持ち場から 2m 以上ずれている選手は 10（追従）として返す
function roleView(m) {
  const a = Uint8Array.from(m.act);
  for (let i = 0; i < NP; i++) {
    if (a[i] === ACT.HOME && i % 11 !== 0) {
      const dx = m.tx[i] - m.hx[i], dy = m.ty[i] - m.hy[i];
      if (dx * dx + dy * dy > 4) a[i] = 10;
    }
  }
  return a;
}

export function frame(m) {
  const xy = new Float32Array(2 * NP);
  for (let i = 0; i < NP; i++) { xy[2 * i] = m.px[i]; xy[2 * i + 1] = m.py[i]; }
  return {
    t: m.t, xy, ball: new Float32Array([m.F[F_B], m.F[F_B + 1], m.F[F_B + 2]]),
    score: [m.N[I.SCORE], m.N[I.SCORE + 1]], phase: m.N[I.PHASE], half: m.N[I.HALF],
    own: m.N[I.OWN], act: roleView(m),
  };
}
