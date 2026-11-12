// 試合エンジン本体（段階1: 土台）。画面に依存しない純粋なJS。Worker でも Node でも動く。
// 状態は2つの型付き配列（F=小数、N=整数）と出来事の記録（log）だけ。保存・復元・比較が簡単になる。
// 時間は固定刻み（20Hz）の整数 tick。乱数は (試合の種, tick, 選手, 用途) から作るので、状態を持たない。
import {
  ENGINE_VERSION, DT, HALF_TICKS, FULL_TICKS, NP, HL, HW, BALL_R,
  F_PX, F_PY, F_VX, F_VY, F_TX, F_TY, F_B, F_R, F_LEN, I, N_LEN, PHASE, NEXT, EV, dirOf,
} from './consts.js';
import { FORMATIONS } from '../data/formations.js';
import { stepBall, BALL_EV } from './ball.js';
import { think, movePlayers, touches } from './brain.js';
import { Digest } from './core/digest.js';
import { clamp } from './core/math.js';

// input = { seed, teams: [ { formation, players: [ { id, ab } x11 ] } x2 ], changes: [] }
// players の並びがスロット（0=GK）。ab は総合力の仮の値（1〜20）。changes は段階2で使う（交代・戦術変更）。
export function createMatch(input) {
  const F = new Float64Array(F_LEN), N = new Int32Array(N_LEN);
  const m = {
    input, seed: input.seed | 0, t: 0, log: [], F, N,
    px: F.subarray(F_PX, F_PX + NP), py: F.subarray(F_PY, F_PY + NP),
    vx: F.subarray(F_VX, F_VX + NP), vy: F.subarray(F_VY, F_VY + NP),
    tx: F.subarray(F_TX, F_TX + NP), ty: F.subarray(F_TY, F_TY + NP),
    cd: N.subarray(0, NP),
    team: new Uint8Array(NP), slot: new Uint8Array(NP),
    fd: new Float64Array(NP), fl: new Float64Array(NP), // 持ち場（奥行・横）
    spd: new Float64Array(NP), err: new Float64Array(NP), // 最高速度・キックの誤差
  };
  for (let k = 0; k < 2; k++) {
    const T = input.teams[k], form = FORMATIONS[T.formation];
    for (let s = 0; s < 11; s++) {
      const i = k * 11 + s, ab = T.players[s].ab;
      m.team[i] = k; m.slot[i] = s;
      m.fd[i] = form[s][0]; m.fl[i] = form[s][1];
      m.spd[i] = 5.5 + 0.13 * ab;
      m.err[i] = 0.3 - 0.01 * ab;
    }
  }
  N[I.LAST] = -1;
  N[I.HALF] = 1;
  placeKickoff(m, 0);
  return m;
}

function placeKickoff(m, kteam) {
  const { F, N, px, py, vx, vy, tx, ty, team, fd, fl, cd } = m;
  for (let i = 0; i < NP; i++) {
    const dir = dirOf(N, team[i]), d = Math.min(fd[i], 0.47);
    px[i] = tx[i] = dir * (d * 2 * HL - HL);
    py[i] = ty[i] = fl[i] * HW * 0.9 * dir;
    vx[i] = vy[i] = 0;
    cd[i] = 0;
  }
  const f = kteam * 11 + 9, dk = dirOf(N, kteam); // キックオフ側のFWをボールの後ろに置く
  px[f] = tx[f] = -dk * 0.5;
  py[f] = ty[f] = 0;
  F[F_B] = F[F_B + 1] = F[F_B + 3] = F[F_B + 4] = F[F_B + 5] = F[F_B + 6] = F[F_B + 7] = 0;
  F[F_B + 2] = BALL_R;
  N[I.LOCK] = 40; N[I.LOCKT] = kteam; N[I.PHASE] = PHASE.LIVE;
}

function pause(m, ticks, next, rteam) {
  const N = m.N;
  N[I.PHASE] = PHASE.PAUSE; N[I.TIMER] = ticks; N[I.NEXT] = next; N[I.RTEAM] = rteam;
}

function resume(m) {
  const { F, N } = m;
  if (N[I.NEXT] === NEXT.KICKOFF) { placeKickoff(m, N[I.RTEAM]); return; }
  F[F_B] = F[F_B + 6] = F[F_R];
  F[F_B + 1] = F[F_B + 7] = F[F_R + 1];
  F[F_B + 2] = BALL_R;
  F[F_B + 3] = F[F_B + 4] = F[F_B + 5] = 0;
  N[I.LOCK] = 30; N[I.LOCKT] = N[I.RTEAM]; N[I.PHASE] = PHASE.LIVE;
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
    F[F_B + 6] = F[F_B]; F[F_B + 7] = F[F_B + 1];
    const ev = stepBall(F, F_B, DT);
    if (ev !== BALL_EV.NONE) onBallEvent(m, ev); else touches(m);
    for (let i = 0; i < NP; i++) if (N[i] > 0) N[i]--;
    if (N[I.LOCK] > 0) N[I.LOCK]--;
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
// xy = 22人の x,y を交互に並べたもの（0〜10がチーム0、11〜21がチーム1）、ball = x,y,z（メートル）
export function frame(m) {
  const xy = new Float32Array(2 * NP);
  for (let i = 0; i < NP; i++) { xy[2 * i] = m.px[i]; xy[2 * i + 1] = m.py[i]; }
  return {
    t: m.t, xy, ball: new Float32Array([m.F[F_B], m.F[F_B + 1], m.F[F_B + 2]]),
    score: [m.N[I.SCORE], m.N[I.SCORE + 1]], phase: m.N[I.PHASE], half: m.N[I.HALF],
  };
}
