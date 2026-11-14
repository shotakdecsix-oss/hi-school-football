// 試合エンジン本体。画面に依存しない純粋なJS。Worker でも Node でも動く。
// 状態は2つの型付き配列（F=小数、N=整数）と出来事の記録（log）だけ。保存・復元・比較が簡単になる。
// 時間は固定刻み（20Hz）の整数 tick。乱数は (試合の種, tick, 選手, 用途) から作るので、状態を持たない。
import {
  ENGINE_VERSION, DT, TICK_HZ, NP, HL, HW, BALL_R, PRED_N,
  F_PX, F_PY, F_VX, F_VY, F_TX, F_TY, F_PC, F_B, F_R, F_STA, F_LEN, F_LEN_P, F_FACE, F_SCN,
  I, N_CD, N_ACT, N_TGT, N_TMR, N_LEN, N_LEN_P, N_LS, NEVER_SEEN, PHASE, NEXT, EV, ACT, SP, SP_WAIT, GOAL_WAIT, ST, ST_N, dirOf,
} from './consts.js';
import { FORMATIONS, ROLE } from '../data/formations.js';
import { normRules } from '../data/rules.js';
import { hash4 } from './core/rng.js';
import { AB, NAB, effVec } from './abil.js';
import { stepBall, BALL_EV } from './ball.js';
import { think, movePlayers, carryBall, touches, takeControl, takerReady, standSpot, keepOut } from './brain.js';
import { decide } from './decide.js';
import { tacParams } from './tactic.js';
import { pkOrder, startPK, stepPK } from './pk.js';
import { fatigue, tire, rest, drainK, recoverK } from './stamina.js';
import { setLook, initLook, look, refreshFace, seeAt, senseAt, memOf, fovOf, NEAR_T1 } from './percept.js';
export { staminaOf } from './stamina.js';
import { Digest } from './core/digest.js';
import { clamp } from './core/math.js';
import { K_RD, K_MKL, K_OFL, K_WRK, K_SEP } from './geom.js';
import { goalCredit } from './touchlog.js';
import { buildZones } from './zones.js';

// input = { seed, teams: [ { formation, tactics, players: [ { id, ab } x11 ], bench: [ { id, ab } ... ] } x2 ], changes: [], rules }
// players の並びがスロット（0=GK）。ab は能力32個の配列（engine/abil.js の順）。数値なら全能力が同じ値。bench は控え（省略可）。
// tactics はチーム指示（data/tactics.js。各項目 -1〜+1、省略・0 = 標準）。
// rules は大会ごとの規定（data/rules.js。省略 = リーグ戦の90分）。
// changes = [ { t, k, type: 'sub', slot, bench } ... ]: t(tick)以降の最初の中断（ボールが出た・ゴールのあと）かハーフタイムで、
// チームkのスロット slot の選手を bench 番目の控えに替える。規定の人数・回数を超える交代、出場済みの控えは実行されない（記録の最後が 0）。
//   { t, k, type: 'tac', tactics }: t(tick)からチームkのチーム指示を tactics に替える（試合中の指示変更）。setTactics が、いまの tick で m.input.changes に足す。
// 入力は createMatch で複製する（呼び出し側があとで書き換えても、この試合には影響しない）。試合の記録 = 最初の入力 + m.input.changes（指示変更が足されていく）。
// 種類 type の変更を、t の順（同じ t は入力の順）に並べる
function sortedChanges(changes, type) {
  return changes.filter((c) => c.type === type).map((c, n) => [c, n]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map((a) => a[0]);
}

// 入力の複製（配列・数値配列・オブジェクト。あとから呼び出し側が書き換えても、復元で能力が変わったりしないように）
function cloneInput(v) {
  if (Array.isArray(v)) return v.map(cloneInput);
  if (ArrayBuffer.isView(v)) return Array.from(v);
  if (v !== null && typeof v === 'object') { const o = {}; for (const key of Object.keys(v)) o[key] = cloneInput(v[key]); return o; }
  return v;
}

export function createMatch(inp) {
  const input = cloneInput(inp);
  if (!input.changes) input.changes = [];
  const pOn = input.percept === undefined || input.percept ? 1 : 0; // 認知（向き・視野・気づき。engine/percept.js）。既定はあり。input.percept = 0 のときだけ、全員が全部見えている従来の動き
  const F = new Float64Array(pOn ? F_LEN_P : F_LEN), N = new Int32Array(pOn ? N_LEN_P : N_LEN);
  if (pOn) N.fill(NEVER_SEEN, N_LS);
  const sub = (a, o) => a.subarray(o, o + NP);
  const rules = normRules(input.rules), h = rules.half * 60 * TICK_HZ, e = rules.et * 60 * TICK_HZ;
  const m = {
    input, seed: input.seed | 0, t: 0, log: [], F, N, pOn,
    rules, pEnd: [h, 2 * h, 2 * h + e, 2 * h + 2 * e], // 規定と、各区間（前半・後半・延長前半・延長後半）が終わる tick（入力から決まる値）
    px: sub(F, F_PX), py: sub(F, F_PY), vx: sub(F, F_VX), vy: sub(F, F_VY), tx: sub(F, F_TX), ty: sub(F, F_TY), pc: sub(F, F_PC),
    cd: sub(N, N_CD), act: sub(N, N_ACT), tgt: sub(N, N_TGT), tmr: sub(N, N_TMR),
    // 入力から決まる値（状態ではない）
    team: new Uint8Array(NP), slot: new Uint8Array(NP), role: new Uint8Array(NP),
    fd: new Float64Array(NP), fl: new Float64Array(NP), // 持ち場（奥行・横）
    ab: new Float64Array(NP * NAB), vmax: new Float64Array(NP), acc: new Float64Array(NP), rgk: new Float64Array(NP),
    vmax0: new Float64Array(NP), acc0: new Float64Array(NP), sdr: new Float64Array(NP), srec: new Float64Array(NP), // 能力から決まる本来の最高速度・加速度と、スタミナの消耗・回復の倍率（vmax・acc は、そこから疲れ分を引いた今の値）
    cx0: new Float64Array(2), kick: new Uint8Array(2),
    cIn: new Float64Array(NP), cOut: new Float64Array(NP), cInH: new Float64Array(NP), cOutH: new Float64Array(NP), wTurn: new Float64Array(NP), tLag: new Float64Array(NP), sepK: new Float64Array(NP), rdK: new Float64Array(NP), mkL: new Float64Array(NP), ofL: new Float64Array(NP), wrkK: new Float64Array(NP), rScan: new Float64Array(NP), fov: new Float64Array(NP), // 認知: 視野の内側・外側の cos、向きを変える速さ、気づくまでの遅れ、気づきの上がる速さ、視野の半角（rad）（能力から決まる）
    fcx: new Float64Array(NP), fcy: new Float64Array(NP), aw: new Float64Array(NP), // 認知: 向きの cos/sin（毎tick作り直す）、判断のたびに作る見えている度合い（作業用）
    tac: [tacParams(input.teams[0].tactics), tacParams(input.teams[1].tactics)], // チーム指示から作った数値（engine/tactic.js）
    changes: sortedChanges(input.changes, 'sub'), // 交代（t の順。入力から決まる値）
    tchg: sortedChanges(input.changes, 'tac'), // 試合中の指示変更（t の順。入力から決まる値）
    nb: new Int8Array(NP * 3).fill(-1), nw: new Float64Array(NP * 3), // 陣形上の隣（持ち場が近い3人）とその重み
    ord: new Int16Array(NP), done: new Uint8Array(NP), // 追従の計算用（作業用）
    rest: new Int8Array(NP).fill(-1), // 攻撃中に後ろへ残す優先順（CB以外の外野手を持ち場の深い順に 0,1,2…。CB・GK は -1）。リスクの指示で、先頭から何人を残すかが決まる（入力から決まる値）
    // 毎tick作り直す作業用（状態ではない）
    hx: new Float64Array(NP), hy: new Float64Array(NP), icT: new Float64Array(NP), icX: new Float64Array(NP), icY: new Float64Array(NP),
    bpx: new Float64Array(PRED_N + 1), bpy: new Float64Array(PRED_N + 1), bpz: new Float64Array(PRED_N + 1), bpb: new Float64Array(6),
    zn: [null, null], zr: new Float64Array(NP * 4), zw: new Float64Array(3), // ゾーン配置（v21）: 陣形の領域の表（入力 zones が 0 でなく表があるときだけ）・毎tick作り直す各選手の領域（作業用）・局面の混ぜ具合（作業用）
    pa: new Uint8Array(NP), mpi: new Int16Array(128), mpo: new Int16Array(128), mpd: new Float64Array(128), usedO: new Uint8Array(NP),
  };
  for (let i = 0; i < NP; i++) F[F_STA + i] = 1; // 全員が万全で始まる
  for (let k = 0; k < 2; k++) {
    const T = input.teams[k], form = FORMATIONS[T.formation];
    m.zn[k] = input.zones === 0 ? null : buildZones(T.formation);
    let sx = 0, deepest = -1;
    for (let s = 0; s < 11; s++) {
      const i = k * 11 + s;
      m.team[i] = k; m.slot[i] = s; m.role[i] = form[s][2];
      m.fd[i] = form[s][0]; m.fl[i] = form[s][1];
      setPlayerAb(m, i, T.players[s].ab);
      if (s > 0) {
        sx += -HL + form[s][0] * 2 * HL;
        if (form[s][0] > deepest) { deepest = form[s][0]; m.kick[k] = s; } // キックオフで使う、最前線の選手
      }
    }
    m.cx0[k] = sx / 10; // 外野手の持ち場の平均（動的な陣形の基準）
    const back = [];
    for (let s = 1; s < 11; s++) if (form[s][2] !== ROLE.C) back.push(s);
    back.sort((a, b) => form[a][0] - form[b][0] || a - b);
    back.forEach((s, r) => { m.rest[k * 11 + s] = r; });
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
  m.pkOrder = pkOrder(m); // PK戦のキッカー順（出場者の能力から決まる値）
  N[I.SUBT] = N[I.SUBT + 1] = -1; N[I.PAUSET] = -1;
  for (let i = 0; i < NP; i++) N[I.OCC + i] = -1; // 全員が先発
  N[I.LAST] = -1;
  N[I.CHGT] = NO_CHG; N[I.POSST] = -1;
  resetTouches(N);
  N[I.HALF] = 1;
  placeKickoff(m, 0);
  return m;
}

// チーム k の指示を、いまの tick から tactics に替える。入力（m.input.changes）に記録するので、記録を最初の入力と合わせれば再現できる。
// 同じ tick の指示変更は、足した順に効く。
export function setTactics(m, k, tactics) {
  const ch = { t: m.t, k, type: 'tac', tactics: cloneInput(tactics) };
  m.input.changes.push(ch);
  let p = m.N[I.TACI];
  while (p < m.tchg.length && m.tchg[p].t <= m.t) p++; // 入力の順で並べ直したときと同じ位置（同じ t の最後）
  m.tchg.splice(p, 0, ch);
  applyTactics(m);
}

// 時刻が来ている指示変更を効かせる（毎 tick の最初）
function applyTactics(m) {
  const { N, tchg } = m;
  while (N[I.TACI] < tchg.length && tchg[N[I.TACI]].t <= m.t) { const c = tchg[N[I.TACI]++]; m.tac[c.k] = tacParams(c.tactics); }
}

// 状態 N の指示変更の番号に合わせて、チーム指示の数値を作り直す（復元のあとに必要）
function refreshTactics(m) {
  const T = m.input.teams;
  m.tac[0] = tacParams(T[0].tactics); m.tac[1] = tacParams(T[1].tactics);
  for (let u = 0; u < m.N[I.TACI]; u++) m.tac[m.tchg[u].k] = tacParams(m.tchg[u].tactics);
}

// ボールに触れた選手の記録を空にする（キックオフのとき）
function resetTouches(N) {
  for (let k = 0; k < 2; k++) { N[I.T1 + k] = -1; N[I.T2 + k] = -1; N[I.T1T + k] = NO_CHG; N[I.T2T + k] = NO_CHG; }
}

// 選手 i（チーム内の位置は固定）に、能力 ab の選手を入れる（入力から決まる値を作り直す）
function setPlayerAb(m, i, ab) {
  const v = effVec(ab); // 実効値（能力の効きを寝かせたもの。abil.js）
  m.ab.set(v, i * NAB);
  m.vmax0[i] = 5.8 + 0.22 * v[AB.SPD]; // 最高速度 (m/s)
  m.acc0[i] = 4 + 0.2 * v[AB.ACC]; // 加速度 (m/s²)
  m.sdr[i] = drainK(v[AB.STM]); m.srec[i] = recoverK(v[AB.STM]);
  fatigue(m, i); // 疲れ分を引いた今の値（vmax・acc）
  m.rgk[i] = m.slot[i] === 0 ? 1.2 + 0.05 * v[AB.GKR] : 0; // GKの届く範囲 (m)
  m.rdK[i] = clamp(1 + K_RD * ((v[AB.POS] + v[AB.MRK]) / 2 - 10), 0.6, 1.8); // 守備の読み: 相手のパスに足が届く範囲の倍率（パスコースを読んで立つ）
  m.mkL[i] = clamp(1 - K_MKL * (v[AB.MRK] - 10), 0.5, 1.6); // マークの見失いやすさの倍率（マークが上手いほど小さい）
  m.ofL[i] = clamp(1 + K_OFL * (v[AB.OFF] - 10), 0.5, 1.8); // 動き出しが上手い相手ほど、守る側は見失いやすい
  m.wrkK[i] = clamp(1 + K_WRK * (v[AB.WRK] - 10), 0.7, 1.3); // ボールを持たない動きの走りの強さ（運動量）。寄せる・戻る・支える・走り込む
  m.sepK[i] = clamp(1 - K_SEP * (v[AB.OFF] - 10), 0.5, 1.5); // 動き出し: パスを受けるとき、相手から離れて受けられる（圧力の倍率。小さいほど楽）
  if (m.pOn) setLook(m, i); // 視野・向きを変える速さなど（認知）
}

// 状態 N の出場者（OCC）に合わせて、能力などの入力から決まる値を作り直す（復元のあとに必要）
function refreshOccupants(m) {
  const T = m.input.teams;
  for (let i = 0; i < NP; i++) {
    const occ = m.N[I.OCC + i], k = m.team[i], s = m.slot[i];
    setPlayerAb(m, i, occ < 0 ? T[k].players[s].ab : T[k].bench[occ].ab);
  }
  m.pkOrder = pkOrder(m);
}

// 中断（ボールが出た・ゴールのあと）かハーフタイム（brk）に、時刻が来ている交代を実行する。
// 人数は規定の subs 人まで、機会は subTimes 回まで（中断ごとに1回と数える。ハーフタイム・延長前は数えない）。延長ではそれぞれ +1。
function applySubs(m, brk) {
  const { N, changes, rules } = m, inEt = N[I.HALF] >= 3;
  while (N[I.SUBI] < changes.length && changes[N[I.SUBI]].t <= m.t) {
    const ch = changes[N[I.SUBI]++], k = ch.k, s = ch.slot, b = ch.bench, bench = (m.input.teams[k] || {}).bench;
    let ok = 0;
    if ((k === 0 || k === 1) && bench && b >= 0 && b < bench.length && s >= 0 && s < 11 && !((N[I.BUSED + k] >> b) & 1)) {
      const newOcc = !brk && N[I.SUBT + k] !== N[I.PAUSET];
      if (N[I.SUBN + k] < rules.subs + (inEt ? 1 : 0) && (!newOcc || N[I.SUBO + k] < rules.subTimes + (inEt ? 1 : 0))) {
        ok = 1;
        N[I.SUBN + k]++;
        if (newOcc) { N[I.SUBO + k]++; N[I.SUBT + k] = N[I.PAUSET]; }
        N[I.BUSED + k] |= 1 << b; N[I.OCC + k * 11 + s] = b;
        m.F[F_STA + k * 11 + s] = 1; // 控えの選手は万全
        setPlayerAb(m, k * 11 + s, bench[b].ab);
      }
    }
    m.log.push([m.t, EV.SUB, k, s, b, ok]);
  }
}

const NO_CHG = -1000000; // 切り替えの窓がない（直近に奪い合いがない）印

function placeKickoff(m, kteam) {
  const { F, N, px, py, vx, vy, tx, ty, pc, team, fd, fl, cd, act, tgt, tmr } = m;
  resetTouches(N);
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
  N[I.OWN] = -1; N[I.RECV] = -1; N[I.PASSK] = -1; N[I.SHOTK] = -1; N[I.POSS] = kteam; N[I.KICKT] = m.t; N[I.SETP] = SP.NONE; N[I.CHGT] = NO_CHG; N[I.POSST] = -1;
  if (m.pOn) initLook(m); // 全員がボールのほうを向く
}

function pause(m, ticks, next, rteam) {
  const N = m.N;
  N[I.PHASE] = PHASE.PAUSE; N[I.TIMER] = ticks; N[I.NEXT] = next; N[I.RTEAM] = rteam;
  N[I.OWN] = -1; N[I.RECV] = -1; N[I.PASSK] = -1; N[I.SHOTK] = -1; N[I.POSS] = rteam; N[I.SETP] = SP.NONE;
  N[I.PAUSET] = m.t; N[I.CHGT] = NO_CHG; N[I.POSST] = -1;
  applySubs(m, false);
}

function resume(m) {
  const { F, N } = m;
  if (N[I.NEXT] === NEXT.KICKOFF) { placeKickoff(m, N[I.RTEAM]); return; }
  F[F_B] = F[F_B + 6] = F[F_R];
  F[F_B + 1] = F[F_B + 7] = F[F_R + 1];
  F[F_B + 2] = BALL_R;
  F[F_B + 3] = F[F_B + 4] = F[F_B + 5] = 0;
  N[I.LOCK] = 30; N[I.LOCKT] = N[I.RTEAM]; N[I.PHASE] = PHASE.LIVE; N[I.KICKT] = m.t;
  const sp = N[I.SETP];
  if (sp > 0) { // 再開: 相手を規定の距離の外へ出し、蹴る選手がボールを持つ（蹴るまでボールは動かない）
    const { px, py, vx, vy, team } = m, tk = N[I.TAKER], rx = F[F_R], ry = F[F_R + 1];
    for (let i = 0; i < NP; i++) {
      if (team[i] === team[tk]) continue;
      const o = keepOut(sp, px[i], py[i], rx, ry);
      if (o) { px[i] = o[0]; py[i] = o[1]; vx[i] = vy[i] = 0; }
    }
    if (!takerReady(m)) { const st = standSpot(sp, rx, ry); px[tk] = st[0]; py[tk] = st[1]; vx[tk] = vy[tk] = 0; }
    m.log.push([m.t, EV.RESTART, sp, tk]);
    takeControl(m, tk);
  }
}

// 再開で蹴る選手: ゴールキックはGK、コーナーは蹴る能力（クロス・セットプレー）が高くて近い選手、スローインは一番近い選手
function pickTaker(m, type, rteam, rx, ry) {
  const { px, py, ab } = m, j0 = rteam * 11;
  if (type === SP.GKICK) return j0;
  let best = j0 + 1, bs = -1e9;
  for (let s = 1; s < 11; s++) {
    const i = j0 + s, dx = px[i] - rx, dy = py[i] - ry, d = Math.sqrt(dx * dx + dy * dy);
    const sc = type === SP.CORNER ? ab[i * NAB + AB.CRS] + 0.5 * ab[i * NAB + AB.SET] - 0.08 * d : -d;
    if (sc > bs) { bs = sc; best = i; }
  }
  return best;
}

// ボールがゴールラインやタッチラインを越えた
function onBallEvent(m, ev) {
  const { F, N } = m;
  if (ev === BALL_EV.GOAL_PX || ev === BALL_EV.GOAL_NX) {
    const k = dirOf(N, 0) === (ev === BALL_EV.GOAL_PX ? 1 : -1) ? 0 : 1; // その向きに攻めているチームの得点
    N[I.SCORE + k]++;
    m.log.push([m.t, EV.GOAL, k, ...goalCredit(m, k, m.t)]); // 得点したチーム、得点者、アシスト、オウンゴール
    pause(m, GOAL_WAIT, NEXT.KICKOFF, 1 - k);
    return;
  }
  const lk = N[I.LAST] >= 0 ? m.team[N[I.LAST]] : 0; // 最後に触ったチーム
  let rteam, rx, ry, type;
  if (ev === BALL_EV.OUT_PX || ev === BALL_EV.OUT_NX) {
    const sx = ev === BALL_EV.OUT_PX ? 1 : -1;
    const def = dirOf(N, 0) === -sx ? 0 : 1; // そのゴールを守るチーム
    if (lk === def) { rteam = 1 - def; rx = sx * (HL - 0.3); ry = F[F_B + 1] > 0 ? HW - 0.3 : -(HW - 0.3); type = SP.CORNER; } // コーナーキック
    else { rteam = def; rx = sx * (HL - 5.5); ry = 0; type = SP.GKICK; } // ゴールキック
  } else {
    rteam = 1 - lk; rx = clamp(F[F_B], -HL + 1, HL - 1); ry = ev === BALL_EV.OUT_PY ? HW - 0.2 : -(HW - 0.2); type = SP.THROW; // スローイン
  }
  m.log.push([m.t, EV.OUT, ev, rteam]);
  F[F_R] = rx; F[F_R + 1] = ry;
  pause(m, SP_WAIT[type], NEXT.RESTART, rteam);
  N[I.SETP] = type; N[I.TAKER] = pickTaker(m, type, rteam, rx, ry);
  N[I.ST + rteam * ST_N + (type === SP.THROW ? ST.THROW : type === SP.GKICK ? ST.GKICK : ST.CORNER)]++;
}

// 1 tick 進める。終了済みなら false。
export function stepMatch(m) {
  const { F, N } = m, ph = N[I.PHASE];
  if (ph === PHASE.END) return false;
  if (ph === PHASE.PK) { stepPK(m); m.t++; return true; }
  applyTactics(m);
  think(m);
  movePlayers(m);
  tire(m);
  if (m.pOn) look(m); // 向きと気づきを更新（認知）
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
  } else if (--N[I.TIMER] <= 0 && (N[I.SETP] === SP.NONE || N[I.TIMER] <= -240 || takerReady(m))) resume(m); // 再開は、蹴る選手がボールの脇に着くまで待つ（最大12秒）
  m.t++;
  if (m.t === m.pEnd[N[I.HALF] - 1]) endPeriod(m);
  return true;
}

// 延長のキックオフをどちらが行うか（コイントス）。延長後半は逆のチーム
const tossTeam = (m) => hash4(m.seed, 0, 0, 800) & 1;

// 区間（前半・後半・延長前半・延長後半）が終わった。次の区間のキックオフか、試合終了。
// 前半→後半: チーム1のキックオフ。後半終了時にノックアウト戦で同点なら延長（なければPK戦）。延長後半終了時に同点ならPK戦。
function endPeriod(m) {
  const { N, rules } = m, p = N[I.HALF], s0 = N[I.SCORE], s1 = N[I.SCORE + 1], level = s0 === s1;
  const go = (half, kteam) => { rest(m); N[I.HALF] = half; placeKickoff(m, kteam); }; // 区間の間の休憩（ハーフタイムなど）で、少し回復する
  const finish = () => { N[I.PHASE] = PHASE.END; m.log.push([m.t, EV.FULL, s0, s1]); };
  if (p === 1) { m.log.push([m.t, EV.HALF, s0, s1]); applySubs(m, true); go(2, 1); }
  else if (p === 2) {
    if (rules.ko && level && rules.et > 0) { m.log.push([m.t, EV.ET, s0, s1]); applySubs(m, true); go(3, tossTeam(m)); }
    else if (rules.ko && level && rules.pk) startPK(m);
    else finish();
  } else if (p === 3) { m.log.push([m.t, EV.HALF, s0, s1]); applySubs(m, true); go(4, 1 - tossTeam(m)); }
  else if (level && rules.pk) startPK(m);
  else finish();
}

// 試合の勝者（0 / 1）。同点（PK戦もなし）や終わっていなければ -1。PK戦まで行った試合は、PKの得点で決まる。
export function winner(m) {
  const N = m.N;
  if (N[I.PHASE] !== PHASE.END) return -1;
  const a = N[I.SCORE], b = N[I.SCORE + 1];
  if (a !== b) return a > b ? 0 : 1;
  const pa = N[I.PKG], pb = N[I.PKG + 1];
  return N[I.HALF] === 5 && pa !== pb ? (pa > pb ? 0 : 1) : -1;
}

// tick が until になるまで進める。stop = { [EV.GOAL]: true } のように渡すと、その出来事が起きた tick で止まり、
// その出来事 [t, 種類, a, b] を返す（止まらずに until / 終了まで進んだら null）。
export function run(m, until = Infinity, stop = null) {
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
  refreshOccupants(m); // 交代があったあとの能力などを作り直す
  refreshTactics(m); // 指示変更があったあとのチーム指示の数値を作り直す
  if (m.pOn) refreshFace(m);
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
  if (m.N[I.PHASE] === PHASE.PK) return a;
  for (let i = 0; i < NP; i++) {
    if (a[i] === ACT.HOME && i % 11 !== 0) {
      const dx = m.tx[i] - m.hx[i], dy = m.ty[i] - m.hy[i];
      if (dx * dx + dy * dy > 4) a[i] = 10;
    }
  }
  return a;
}

// vp: 見え方を調べる選手（省略 = ボールを持っている選手）。認知ありのとき、その選手から見た全員の見えている度合い（0〜1）を see に入れる（表示用）
export function frame(m, vp = -1) {
  const xy = new Float32Array(2 * NP);
  for (let i = 0; i < NP; i++) { xy[2 * i] = m.px[i]; xy[2 * i + 1] = m.py[i]; }
  const seeBy = m.pOn ? (vp >= 0 ? vp : m.N[I.OWN]) : -1;
  let see = null, vis = null; // see: その選手がどれだけ分かっているか（味方は視野か記憶、相手は視野か気づき） vis: いま視野に入っている度合い
  if (seeBy >= 0) {
    see = new Float32Array(NP); vis = new Float32Array(NP);
    const k = m.team[seeBy], full = m.N[I.SETP] !== SP.NONE;
    for (let j = 0; j < NP; j++) {
      if (j === seeBy) { see[j] = vis[j] = 1; continue; }
      const v = seeAt(m, seeBy, m.px[j], m.py[j], m.team[j] === k ? NEAR_T1 : undefined);
      vis[j] = v;
      if (m.team[j] !== k) see[j] = senseAt(m, seeBy, m.px[j], m.py[j]);
      else { const e = full ? 1 : memOf(m, seeBy, j); see[j] = v > e ? v : e; }
    }
  }
  return {
    t: m.t, xy, ball: new Float32Array([m.F[F_B], m.F[F_B + 1], m.F[F_B + 2]]),
    score: [m.N[I.SCORE], m.N[I.SCORE + 1]], phase: m.N[I.PHASE], half: m.N[I.HALF],
    pk: [m.N[I.PKG], m.N[I.PKG + 1]], pkr: m.N[I.PKR], // PK戦の得点と、直近のキックの結果（-1=まだ 0=外れ 1=ゴール 2=セーブ）
    own: m.N[I.OWN], act: roleView(m),
    face: m.pOn ? Float32Array.from(m.F.subarray(F_FACE, F_FACE + NP)) : null, // 認知ありのとき、22人の体の向き（rad）
    fov: m.pOn ? Float32Array.from({ length: NP }, (_, i) => fovOf(m, i)) : null, scn: m.pOn ? Float32Array.from(m.F.subarray(F_SCN, F_SCN + NP)) : null, // 視野の半角（rad）・気づき（0〜1）
    seeBy, see, vis,
  };
}
