// 自動テスト。node tools/test.js（または npm test）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../engine/core/math.js';
import { hash4, f4, normal4, Stream } from '../engine/core/rng.js';
import { createMatch, stepMatch, run, snapshot, restore, snapshotToJSON, digestMatch, winner, staminaOf, frame, setTactics } from '../engine/match.js';
import { predictBall } from '../engine/brain.js';
import { markTouch, goalCredit } from '../engine/touchlog.js';
import { selfCheck } from '../engine/selfcheck.js';
import { Digest } from '../engine/core/digest.js';
import { startPK, pkDecided } from '../engine/pk.js';
import { AB, NAB, abVec } from '../engine/abil.js';
import { sampleInput } from '../engine/sample.js';
import { stepBall } from '../engine/ball.js';
import { FULL_TICKS, HALF_TICKS, HL, HW, NP, I, PHASE, EV, F_B, F_R, F_STA, F_PASS, F_LEN, F_LEN_P, F_FACE, F_SCN, N_LS, N_LEN, NEVER_SEEN, BALL_R, PRED_N, PRED_TICKS, DT, PA_D, PA_HW, SP, ST, ACT, dirOf } from '../engine/consts.js';
import { decide } from '../engine/decide.js';
import { seeAt, seeAll, senseAt, memOf, blindOf, fovOf, lagOf, look, refreshFace } from '../engine/percept.js';
import { TACTICS, normTactics } from '../data/tactics.js';
import { STYLES } from '../data/styles.js';
import { tacParams } from '../engine/tactic.js';
import { RULES, normRules } from '../data/rules.js';
import { computeGolden } from './golden-core.js';

let fails = 0;
const ONLY = process.env.ONLY; // 例: ONLY=攻撃の指示 node tools/test.js（名前にその文字を含む検査だけ走らせる）
const test = async (name, fn) => {
  if (ONLY && !name.includes(ONLY)) return;
  try {
    const note = await fn();
    console.log('  ok  ' + name + (note ? '  … ' + note : ''));
  } catch (e) {
    fails++;
    console.log('FAIL  ' + name + '\n        ' + String((e && e.message) || e).split('\n').join('\n        '));
  }
};
const OPT = { home: '4-4-2', away: '4-3-3', abilHome: 11, abilAway: 9 };
const mk = (seed, o = OPT) => createMatch(sampleInput(seed, o));

// ── 決定的な数学 ──
await test('math: sin/cos/atan2/exp/log が標準の関数と 1e-12 以内で一致', () => {
  let es = 0, ea = 0, ee = 0, el = 0;
  for (let i = -20000; i <= 20000; i++) {
    const x = i * 0.005;
    es = Math.max(es, Math.abs(M.sin(x) - Math.sin(x)), Math.abs(M.cos(x) - Math.cos(x)));
  }
  for (let i = 0; i < 720; i++) {
    for (const r of [0.3, 1, 40]) {
      const a = i * 0.00873, y = r * Math.sin(a), x = r * Math.cos(a);
      ea = Math.max(ea, Math.abs(M.wrapAngle(M.atan2(y, x) - Math.atan2(y, x))));
    }
  }
  for (let i = -3000; i <= 3000; i++) { const x = i * 0.01; ee = Math.max(ee, Math.abs(M.exp(x) / Math.exp(x) - 1)); }
  for (let i = 0; i <= 1200; i++) { const x = 1e-6 * Math.pow(10, i * 0.01); el = Math.max(el, Math.abs(M.log(x) - Math.log(x))); }
  for (const [n, e] of [['sin/cos', es], ['atan2', ea], ['exp', ee], ['log', el]]) assert.ok(e < 1e-12, `${n} の誤差 ${e}`);
  return `最大誤差 sin/cos ${es.toExponential(1)} atan2 ${ea.toExponential(1)} exp ${ee.toExponential(1)} log ${el.toExponential(1)}`;
});

// ── 乱数 ──
await test('rng: 同じ入力は同じ値、入力が違えば違う値（衝突もほぼ無い）', () => {
  assert.equal(hash4(1, 2, 3, 4), hash4(1, 2, 3, 4));
  assert.notEqual(hash4(1, 2, 3, 4), hash4(1, 2, 3, 5));
  const s = new Set();
  for (let i = 0; i < 20000; i++) s.add(hash4(7, i, 0, 0));
  assert.ok(s.size >= 19990, '衝突が多い: ' + (20000 - s.size));
});
await test('rng: 一様性（16区間のカイ二乗）と正規分布の平均・標準偏差', () => {
  const bins = new Array(16).fill(0), N = 160000;
  for (let i = 0; i < N; i++) bins[Math.floor(f4(42, i, 1, 2) * 16)]++;
  let chi = 0;
  for (const b of bins) chi += (b - N / 16) ** 2 / (N / 16);
  assert.ok(chi < 50, 'chi2=' + chi.toFixed(1));
  let s1 = 0, s2 = 0, mx = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) { const z = normal4(9, i, 3, 5); s1 += z; s2 += z * z; mx = Math.max(mx, Math.abs(z)); }
  const mean = s1 / n, sd = Math.sqrt(s2 / n - mean * mean);
  assert.ok(Math.abs(mean) < 0.02 && Math.abs(sd - 1) < 0.02 && mx <= 4, `mean=${mean} sd=${sd} max=${mx}`);
  return `chi2=${chi.toFixed(1)} 平均=${mean.toFixed(3)} 標準偏差=${sd.toFixed(3)}`;
});
await test('rng: 入力の1bitの違いが、出力のおよそ半分のbitを変える', () => {
  let tot = 0, cnt = 0;
  for (let i = 0; i < 2000; i++) {
    for (let b = 0; b < 32; b += 5) {
      let c = 0;
      for (let v = hash4(5, i, 77, 1) ^ hash4(5, i ^ (1 << b), 77, 1); v; v &= v - 1) c++;
      tot += c; cnt++;
    }
  }
  const avg = tot / cnt;
  assert.ok(avg > 15 && avg < 17, 'avg=' + avg);
  return `平均 ${avg.toFixed(2)} / 32 bit`;
});
await test('rng: Stream は状態を保存・復元できる', () => {
  const draw = (s) => Array.from({ length: 10 }, () => s.u32());
  const a = new Stream(1, 2, 3);
  draw(a);
  const st = a.state(), x = draw(a);
  const b = new Stream(9, 9, 9);
  b.setState(st);
  assert.deepEqual(draw(b), x); // 状態を戻せば、別の種で作った Stream でも続きが同じ
  const c = new Stream(1, 2, 3);
  draw(c);
  assert.deepEqual(draw(c), x); // 同じ種・同じ順なら同じ値
});

// ── ボール物理 ──
await test('ball: 転がり・バウンド・ゴール判定', () => {
  const F = new Float64Array(8);
  F[0] = -45; F[2] = 0.11; F[3] = 20;
  let ev = 0;
  for (let t = 0; t < 400 && !ev; t++) ev = stepBall(F, 0, 0.05);
  assert.equal(ev, 0);
  assert.ok(Math.abs(F[0] - -5) < 0.5 && F[3] === 0, `止まった位置 x=${F[0]}`); // 20m/s ÷ 0.5 = 40m
  const G = new Float64Array(8);
  G[2] = 10;
  const apex = [];
  let prevUp = false;
  for (let t = 0; t < 400; t++) {
    stepBall(G, 0, 0.05);
    if (prevUp && G[5] <= 0) apex.push(G[2]);
    prevUp = G[5] > 0;
  }
  assert.ok(apex.length >= 2 && apex[0] < 6 && apex[1] < apex[0] * 0.6, '跳ね方: ' + apex.map((v) => v.toFixed(2)));
  assert.ok(Math.abs(G[2] - 0.11) < 1e-9 && G[5] === 0, '最後は地面で止まる');
  const shoot = (y, z, vx, vy) => {
    const B = new Float64Array(8);
    B[0] = 50; B[1] = y; B[2] = z; B[3] = vx; B[4] = vy;
    let ev = 0;
    for (let t = 0; t < 20 && !ev; t++) ev = stepBall(B, 0, 0.05);
    return ev;
  };
  assert.equal(shoot(0, 1, 20, 0), 1, 'ゴール');
  assert.equal(shoot(5, 1, 20, 0), 3, 'ゴール横に外れる');
  assert.equal(shoot(0, 3, 20, 0), 3, 'バーの上');
  assert.equal(shoot(33.9, 0.11, 0, 10), 5, 'タッチライン');
  return `バウンドの頂点 ${apex.slice(0, 3).map((v) => v.toFixed(2)).join(' → ')} m`;
});

// ── 試合 ──
await test('match: 同じ入力は同じ結果（途中・最後のチェック値が一致）、種が違えば違う展開', () => {
  const a = mk(11), b = mk(11);
  for (const T of [1, 600, 6000, HALF_TICKS, FULL_TICKS]) {
    run(a, T); run(b, T);
    assert.equal(digestMatch(a), digestMatch(b), 'tick ' + T);
  }
  const c = mk(12);
  run(c);
  assert.notEqual(digestMatch(c), digestMatch(a));
});
await test('match: 90分で終わり、値が壊れず、選手とボールがピッチ付近にいる', () => {
  let goals = 0, shots = 0, outs = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const m = mk(seed);
    while (m.N[I.PHASE] !== PHASE.END) {
      stepMatch(m);
      if (m.t % 97 === 0) {
        for (let j = 0; j < m.F.length; j++) assert.ok(Number.isFinite(m.F[j]), `seed${seed} t${m.t} F[${j}]`);
        for (let i = 0; i < NP; i++) assert.ok(Math.abs(m.px[i]) <= HL + 2.01 && Math.abs(m.py[i]) <= HW + 2.01, `選手${i}が範囲外`);
        assert.ok(Math.abs(m.F[F_B]) <= HL + 1 && Math.abs(m.F[F_B + 1]) <= HW + 1, `ボールが範囲外 t${m.t}`);
      }
    }
    assert.equal(m.t, FULL_TICKS);
    goals += m.N[I.SCORE] + m.N[I.SCORE + 1];
    shots += m.N[I.SHOTS] + m.N[I.SHOTS + 1];
    outs += m.log.filter((e) => e[1] === EV.OUT).length;
  }
  assert.ok(goals >= 1 && goals / 6 <= 12, `1試合の平均得点 ${goals / 6}`);
  assert.ok(outs >= 6, '場外が起きていない');
  return `6試合: 得点 ${goals}、シュート ${shots}、場外 ${outs}`;
});
await test('match: 得点で止めて続きを走らせても、通しで走らせた結果と同じ', () => {
  let seed = 1, a, ev;
  for (; seed <= 30; seed++) { a = mk(seed); ev = run(a, FULL_TICKS, { [EV.GOAL]: true }); if (ev) break; }
  assert.ok(ev && a.t < FULL_TICKS, '得点の出る試合が見つからない');
  run(a);
  const b = mk(seed);
  run(b);
  assert.equal(digestMatch(a), digestMatch(b));
});
await test('match: 途中の保存→復元→再開が通しの結果と同じ（同じ箱・新しい箱・JSON経由）', () => {
  const input = sampleInput(5, OPT), ref = createMatch(input);
  run(ref, 30000);
  const snap = snapshot(ref);
  run(ref);
  const D = digestMatch(ref);
  restore(ref, snap); run(ref);
  assert.equal(digestMatch(ref), D, '同じ箱');
  const fresh = createMatch(input);
  restore(fresh, snap); run(fresh);
  assert.equal(digestMatch(fresh), D, '新しい箱');
  const viaJson = createMatch(input);
  restore(viaJson, JSON.parse(JSON.stringify(snapshotToJSON(snap)))); run(viaJson);
  assert.equal(digestMatch(viaJson), D, 'JSON経由');
});

// ── 大会規定（試合の長さ・延長） ──
const SHORT = { half: 2, et: 1, pk: false, ko: true, subs: 5, subTimes: 3 }; // 4分 + 延長2分（テスト用）
const mkR = (seed, rules) => createMatch(sampleInput(seed, { ...OPT, rules }));
await test('rules: 大会ごとの長さ（選手権系80分・インターハイ系70分・リーグ戦90分）。省略はリーグ戦', () => {
  const len = (r) => mkR(1, r).pEnd.map((t) => t / 1200);
  assert.deepEqual(len(RULES.sensyuken), [40, 80, 90, 100]);
  assert.deepEqual(len(RULES.interhigh), [35, 70, 70, 70]);
  assert.deepEqual(len(RULES.interhighFinal), [35, 70, 80, 90]);
  assert.deepEqual(len(undefined), [45, 90, 90, 90]);
  assert.deepEqual(normRules(undefined), normRules(RULES.league));
});
await test('rules: 規定の長さで終わる。同点でもノックアウトでなければ延長しない', () => {
  const m = mkR(2, { ...SHORT, ko: false });
  run(m);
  assert.equal(m.t, 4 * 1200);
  assert.equal(m.N[I.PHASE], PHASE.END);
  assert.equal(m.log.filter((e) => e[1] === EV.ET).length, 0);
});
await test('rules: ノックアウト戦は、同点なら延長（前後半）に入り、決着していれば入らない。延長をまたぐ保存・復元も一致', () => {
  let nExtra = 0, nReg = 0;
  for (let seed = 1; seed <= 80 && (nExtra < 3 || nReg < 2); seed++) { // 4分では決着する試合が少ないので、両方の場合が出るまで種を変えて試す
    const m = mkR(seed, SHORT), input = m.input;
    run(m, m.pEnd[1]);
    const s0 = m.N[I.SCORE], s1 = m.N[I.SCORE + 1], ets = m.log.filter((e) => e[1] === EV.ET);
    if (s0 !== s1) { // 規定の時間で決着
      nReg++;
      assert.equal(m.N[I.PHASE], PHASE.END); assert.equal(m.t, m.pEnd[1]); assert.equal(ets.length, 0);
      continue;
    }
    nExtra++;
    assert.equal(m.N[I.PHASE] === PHASE.END, false, '同点なのに終わっている'); assert.equal(m.N[I.HALF], 3);
    assert.equal(ets.length, 1); assert.equal(ets[0][0], m.pEnd[1]);
    run(m, m.pEnd[2] - 200); // 延長前半の終わり際で保存
    const snap = snapshot(m);
    run(m);
    assert.equal(m.t, m.pEnd[3]); assert.equal(m.N[I.HALF], 4); assert.equal(m.N[I.PHASE], PHASE.END);
    assert.ok(m.log.some((e) => e[1] === EV.HALF && e[0] === m.pEnd[2]), '延長前半の終わりの記録');
    const D = digestMatch(m), fresh = createMatch(input);
    restore(fresh, snap); run(fresh);
    assert.equal(digestMatch(fresh), D, '延長をまたぐ復元');
  }
  assert.ok(nExtra >= 1 && nReg >= 1, `延長に入った試合 ${nExtra}、規定の時間で決着した試合 ${nReg}`);
  return `延長 ${nExtra}、決着 ${nReg}`;
});

// ── 再開（スローイン・ゴールキック・コーナー）──
await test('restart: 再開は正しいチームの選手がボールを持って始め、相手は規定の距離（スロー2m・コーナー9.15m・GKはエリア外）の外', () => {
  const cnt = [0, 0, 0, 0];
  for (let seed = 1; seed <= 4; seed++) {
    const m = mk(seed);
    let n0 = 0;
    while (m.N[I.PHASE] !== PHASE.END) {
      stepMatch(m);
      for (; n0 < m.log.length; n0++) {
        const e = m.log[n0];
        if (e[1] !== EV.RESTART) continue;
        const sp = e[2], tk = e[3], rx = m.F[F_R], ry = m.F[F_R + 1], sx = rx > 0 ? 1 : -1;
        cnt[sp]++;
        assert.equal(m.team[tk], m.N[I.RTEAM], '蹴るのは再開するチームの選手');
        assert.equal(m.N[I.OWN], tk, '蹴る選手がボールを持っている');
        assert.ok(Math.abs(m.F[F_B] - rx) < 1e-6 && Math.abs(m.F[F_B + 1] - ry) < 1e-6, 'ボールは置かれた位置');
        if (sp === SP.GKICK) assert.equal(tk % 11, 0, 'ゴールキックはGK');
        for (let i = 0; i < NP; i++) {
          if (m.team[i] === m.team[tk]) continue;
          const d = Math.hypot(m.px[i] - rx, m.py[i] - ry);
          if (sp === SP.THROW) assert.ok(d >= 2.1, `スローインで相手が近すぎる ${d.toFixed(2)}m seed ${seed} t ${e[0]}`);
          if (sp === SP.CORNER) assert.ok(d >= 9.3, `コーナーで相手が近すぎる ${d.toFixed(2)}m seed ${seed} t ${e[0]}`);
          if (sp === SP.GKICK) assert.ok(!(m.px[i] * sx > HL - PA_D && Math.abs(m.py[i]) < PA_HW), `ゴールキックで相手がエリア内 seed ${seed} t ${e[0]}`);
        }
      }
    }
  }
  assert.ok(cnt[SP.THROW] > 0 && cnt[SP.GKICK] > 0 && cnt[SP.CORNER] > 0, `スロー${cnt[1]} GK${cnt[2]} CK${cnt[3]}`);
  return `4試合: スローイン${cnt[1]} ゴールキック${cnt[2]} コーナー${cnt[3]}`;
});

// ── PK戦 ──
const PKR = { half: 1, et: 0, pk: true, ko: true, subs: 5, subTimes: 3 };
await test('pk: 勝敗の決まり方（5本ずつの間の途中決着・サドンデス）', () => {
  assert.equal(pkDecided(3, 3, 3, 0), 0); // 残り2本を決めても追いつけない
  assert.equal(pkDecided(3, 3, 3, 1), -1);
  assert.equal(pkDecided(4, 5, 3, 5), 1);
  assert.equal(pkDecided(4, 5, 3, 4), -1); // 先攻にあと1本ある
  assert.equal(pkDecided(5, 4, 4, 4), -1); // 後攻にあと1本ある
  assert.equal(pkDecided(5, 5, 3, 3), -1); // サドンデスへ
  assert.equal(pkDecided(5, 5, 4, 3), 0);
  assert.equal(pkDecided(6, 5, 4, 3), -1); // サドンデスは同じ本数を蹴り終えてから
  assert.equal(pkDecided(6, 6, 4, 3), 0);
  assert.equal(pkDecided(6, 6, 3, 4), 1);
});
await test('pk: PK戦が規則どおりに進んで終わる（交互に蹴る・決着した本で終わる・勝者はPKの得点が多い側）', () => {
  let total = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const m = mkR(seed, PKR);
    startPK(m); run(m);
    assert.equal(m.N[I.PHASE], PHASE.END);
    const ks = m.log.filter((e) => e[1] === EV.PKK), first = m.N[I.PKF], goals = [0, 0], cnt = [0, 0];
    ks.forEach((e, n) => {
      const team = e[2], kicker = e[3], res = e[4];
      assert.equal(team, first ^ (n & 1), '交互に蹴る'); assert.equal(m.team[kicker], team, 'キッカーは蹴るチームの選手');
      cnt[team]++; if (res === 1) goals[team]++;
      const w = pkDecided(cnt[0], cnt[1], goals[0], goals[1]);
      if (n < ks.length - 1) assert.equal(w, -1, `seed ${seed}: 決着したのに続けている`); else assert.ok(w >= 0, `seed ${seed}: 決着していないのに終わっている`);
    });
    assert.deepEqual(goals, [m.N[I.PKG], m.N[I.PKG + 1]]);
    assert.equal(winner(m), goals[0] > goals[1] ? 0 : 1);
    total += ks.length;
  }
  return `16回: 平均 ${(total / 16).toFixed(1)} 本`;
});
await test('pk: 1本ごとの結果が実際の水準（ゴール6〜8.5割・セーブ1〜3割・外れ2割未満）', () => {
  const c = [0, 0, 0];
  for (let seed = 1; seed <= 60; seed++) {
    const m = mkR(seed, PKR);
    startPK(m); run(m);
    for (const e of m.log) if (e[1] === EV.PKK) c[e[4]]++;
  }
  const n = c[0] + c[1] + c[2], f = c.map((x) => x / n);
  assert.ok(f[1] > 0.6 && f[1] < 0.85 && f[2] > 0.1 && f[2] < 0.3 && f[0] < 0.2, `外れ ${f[0].toFixed(2)} ゴール ${f[1].toFixed(2)} セーブ ${f[2].toFixed(2)}`);
  return `${n}本: ゴール ${(100 * f[1]).toFixed(0)}% セーブ ${(100 * f[2]).toFixed(0)}% 外れ ${(100 * f[0]).toFixed(0)}%`;
});
await test('pk: PK戦の途中の保存・復元が一致', () => {
  for (const seed of [3, 5, 8]) {
    const m = mkR(seed, PKR), input = m.input;
    startPK(m); run(m, m.t + 900); // 2本目あたり
    assert.equal(m.N[I.PHASE], PHASE.PK);
    const snap = snapshot(m);
    run(m);
    const D = digestMatch(m), fresh = createMatch(input);
    restore(fresh, snap); run(fresh);
    assert.equal(digestMatch(fresh), D, 'PK戦をまたぐ復元');
  }
});
await test('pk: 延長でも同点ならPK戦で決着する（試合の流れの中で）', () => {
  let n = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const m = mkR(seed, { ...SHORT, pk: true });
    run(m);
    assert.equal(m.N[I.PHASE], PHASE.END);
    assert.ok(winner(m) >= 0, '勝者が決まっている');
    if (m.N[I.SCORE] === m.N[I.SCORE + 1]) { n++; assert.equal(m.N[I.HALF], 5); assert.equal(m.log.filter((e) => e[1] === EV.PK).length, 1); }
  }
  assert.ok(n >= 1, 'PK戦まで行った試合が無い');
  return `8試合のうち PK戦 ${n}`;
});

// ── 選手交代 ──
const SUBR = { half: 8, et: 0, pk: false, ko: false, subs: 5, subTimes: 3 }; // 8分ずつ（テスト用）
const MIN = 1200; // 1分 = 1200 tick
const mkS = (seed, changes, rules = SUBR) => createMatch(sampleInput(seed, { ...OPT, rules, changes }));
const sub = (t, k, slot, bench) => ({ t, k, type: 'sub', slot, bench });
const subLog = (m) => m.log.filter((e) => e[1] === EV.SUB);
const abvec = (input, k, b) => Array.from(abVec(input.teams[k].bench[b].ab)); // 控え b の能力
await test('sub: 時刻のあとの最初の中断で交代し、控えの能力に入れ替わる', () => {
  const m = mkS(4, [sub(3 * MIN, 0, 9, 2)]), input = m.input;
  const before = Array.from(m.ab.subarray(9 * NAB, 10 * NAB));
  run(m, 3 * MIN - 1);
  assert.equal(subLog(m).length, 0, '時刻の前には交代しない');
  // 中断の間隔は展開しだい（数分あくこともある）なので、固定の分数では測らず、中断の始まりを拾って「最初の中断」と照らす
  const pauses = []; let prev = m.N[I.PHASE];
  while (m.t < SUBR.half * MIN && m.N[I.PHASE] !== PHASE.END) { stepMatch(m); const ph = m.N[I.PHASE]; if (ph === PHASE.PAUSE && prev !== PHASE.PAUSE) pauses.push(m.t); prev = ph; }
  const L = subLog(m), first = pauses.find((t) => t >= 3 * MIN);
  assert.equal(L.length, 1);
  assert.ok(first !== undefined && Math.abs(L[0][0] - first) <= 2, `時刻のあとの最初の中断（t=${first}）で行われる（実行 t=${L[0][0]}）`);
  assert.deepEqual(L[0].slice(2), [0, 9, 2, 1]);
  const bench = Array.from(abVec(input.teams[0].bench[2].ab));
  assert.deepEqual(Array.from(m.ab.subarray(9 * NAB, 10 * NAB)), bench);
  assert.notDeepEqual(before, bench);
  assert.equal(m.vmax0[9], 5.8 + 0.22 * bench[AB.SPD]);
});
await test('sub: 人数（5人）・機会（3回）・同じ控えの再出場に上限があり、超えた交代は実行されない（記録の最後が0）', () => {
  const ok = (m) => { run(m); return subLog(m).map((e) => e[5]); };
  // 中断の間隔は展開しだい（数分あくこともある）。依頼を5分ずつ離して、どの依頼も別々の中断になるようにする（エンジンを変えても崩れにくい）
  assert.deepEqual(ok(mkS(5, [sub(1 * MIN, 0, 1, 0), sub(6 * MIN, 0, 2, 1), sub(11 * MIN, 0, 3, 2), sub(16 * MIN, 0, 4, 3)], { ...SUBR, half: 20 })), [1, 1, 1, 0], '機会は3回まで');
  assert.deepEqual(ok(mkS(5, [1, 2, 3, 4, 5, 6].map((s, n) => sub(2 * MIN, 1, s, n)))), [1, 1, 1, 1, 1, 0], '人数は5人まで（同じ機会に6人）');
  assert.deepEqual(ok(mkS(5, [sub(1 * MIN, 0, 1, 0), sub(3 * MIN, 0, 2, 0)])), [1, 0], '同じ控えは1度だけ');
  assert.deepEqual(ok(mkS(5, [sub(1 * MIN, 0, 11, 0), sub(1 * MIN, 0, 1, 99), sub(1 * MIN, 2, 1, 0)])), [0, 0, 0], '存在しないスロット・控え・チーム');
});
await test('sub: ハーフタイムの交代は機会に数えない（そのあと3回できる）', () => {
  const HT = SUBR.half * MIN, m = mkS(6, [sub(HT, 0, 1, 0), sub(HT + 1 * MIN, 0, 2, 1), sub(HT + 3 * MIN, 0, 3, 2), sub(HT + 5 * MIN, 0, 4, 3)]);
  run(m);
  const L = subLog(m);
  assert.deepEqual(L.map((e) => e[5]), [1, 1, 1, 1]);
  assert.equal(L[0][0], HT, 'ハーフタイムに実行');
});
await test('sub: 交代をまたぐ保存・復元が一致（復元後は出場者に合わせた能力で動く。交代前の状態へも戻せる）', () => {
  const ch = [sub(2 * MIN, 0, 9, 2), sub(2 * MIN, 1, 0, 0)], m = mkS(7, ch), input = m.input;
  run(m, 1 * MIN);
  const early = snapshot(m);
  run(m, 4 * MIN);
  assert.deepEqual(subLog(m).map((e) => e[5]), [1, 1]);
  assert.equal(m.rgk[11], 1.2 + 0.05 * abvec(input, 1, 0)[AB.GKR], '交代で入ったGKの届く範囲');
  const late = snapshot(m);
  run(m);
  const D = digestMatch(m), fresh = createMatch(input);
  restore(fresh, late); run(fresh);
  assert.equal(digestMatch(fresh), D, '交代のあとの保存から');
  restore(m, early); run(m); // 同じ試合を、交代が起きる前の保存へ戻して続ける
  assert.equal(digestMatch(m), D, '交代の前の保存へ戻して');
});

// ── チーム指示 ──
await test('tactics: 指示は -1〜+1 にそろえる（省略・範囲外・数でない値）。全部 0 の指示は、指示なしと同じ数値になる', () => {
  const n = normTactics({ line: 5, compact: -9, pressPower: NaN, defStyle: '1', nosuch: 1 });
  assert.deepEqual([n.line, n.compact, n.pressPower, n.defStyle], [1, -1, 0, 0]);
  assert.equal(Object.keys(n).length, TACTICS.length);
  assert.deepEqual(tacParams(Object.fromEntries(TACTICS.map((d) => [d.key, 0]))), tacParams(undefined));
});
await test('tactics: 指示を省略した試合・全部0の試合は、これまでの動きと同じ（チェック値が一致）', () => {
  const zero = Object.fromEntries(TACTICS.map((d) => [d.key, 0]));
  const a = createMatch(sampleInput(4, OPT)), b = createMatch(sampleInput(4, { ...OPT, homeTac: zero, awayTac: {} }));
  run(a, 12000); run(b, 12000);
  assert.equal(digestMatch(a), digestMatch(b));
});
await test('tactics: 指示ありでも、同じ入力は同じ結果で、途中の保存→復元→再開も通しと一致', () => {
  const T = { line: 1, compact: 0.6, pressZone: -0.5, pressPower: 0.7, defStyle: -1, width: 0.8, tempo: -0.6, attack: 0.5, risk: 0.9, onWin: 0.5, onLose: 0.7 }, U = { line: -0.8, compact: -0.3, pressZone: 0.9, pressPower: -0.6, defStyle: 1, width: -0.7, tempo: 0.9, attack: -1, risk: -0.8, onWin: -0.5, onLose: -0.6 };
  const input = sampleInput(8, { ...OPT, homeTac: T, awayTac: U }), a = createMatch(input), b = createMatch(input);
  run(a, 20000); run(b, 20000);
  assert.equal(digestMatch(a), digestMatch(b), '同じ入力');
  const snap = snapshot(a);
  run(a);
  const D = digestMatch(a), fresh = createMatch(input);
  restore(fresh, snap); run(fresh);
  assert.equal(digestMatch(fresh), D, '保存→復元');
});
// 守備中（相手がボールを持ち、ボールが中盤にある間）のチーム0の陣形: 最終ライン（外野手の深い4人の平均の深さ）・縦幅・横幅。
// press = ボールが敵陣側（自分の向きで+17.5m より先）にあるときの寄せ役（PRESS）の平均人数。tkl = タックルの回数
function blockStats(tac, seeds = [1, 2, 3, 4, 5, 6], minutes = 10) {
  const o = { n: 0, line: 0, len: 0, wid: 0, farN: 0, farPress: 0, tkl: 0 };
  for (const seed of seeds) {
    const m = createMatch(sampleInput(seed, { ...OPT, homeTac: tac }));
    while (m.t < minutes * 1200 && stepMatch(m)) {
      if (m.t % 10 || m.N[I.PHASE] !== PHASE.LIVE) continue;
      const own = m.N[I.OWN];
      if (own < 0 || m.team[own] === 0) continue;
      const dir = dirOf(m.N, 0), bfx = m.F[F_B] * dir, fxs = [];
      let pr = 0, y0 = 99, y1 = -99;
      for (let i = 1; i < 11; i++) { fxs.push(m.px[i] * dir); y0 = Math.min(y0, m.py[i] * dir); y1 = Math.max(y1, m.py[i] * dir); if (m.act[i] === ACT.PRESS) pr++; }
      fxs.sort((a, b) => a - b);
      if (bfx > 17.5) { o.farN++; o.farPress += pr; }
      if (bfx < -17.5 || bfx > 17.5) continue;
      o.n++; o.line += (fxs[0] + fxs[1] + fxs[2] + fxs[3]) / 4; o.len += fxs[9] - fxs[0]; o.wid += y1 - y0;
    }
    o.tkl += m.N[I.ST + ST.TKL];
  }
  return { line: o.line / o.n, len: o.len / o.n, wid: o.wid / o.n, press: o.farPress / Math.max(1, o.farN), tkl: o.tkl };
}
await test('tactics: 守備の指示が陣形に効く（ライン高さ・コンパクトさ・プレス開始位置・プレス強度）', () => {
  const S = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // 横幅の差は約 2m と小さく、6試合ではぶれるので 12試合で見る
  const base = blockStats({}, S), hi = blockStats({ line: 1 }, S), lo = blockStats({ line: -1 }, S);
  const cp = blockStats({ compact: 1 }, S), lp = blockStats({ compact: -1 }, S), wait = blockStats({ pressZone: -1 }, S);
  const S30 = Array.from({ length: 30 }, (_, i) => i + 1); // v14: タックルの回数は数十回でぶれるので（12試合では差がほぼ消えた）、プレス強度だけ30試合で見る（40試合の測定では 弱166・標準252・強277 回）
  const pp = blockStats({ pressPower: 1 }, S30), pm = blockStats({ pressPower: -1 }, S30);
  const f = (x) => x.toFixed(1);
  assert.ok(hi.line > base.line + 5, `ラインが高い: ${f(hi.line)} (標準 ${f(base.line)})`);
  assert.ok(lo.line < base.line - 3, `ラインが低い: ${f(lo.line)} (標準 ${f(base.line)})`);
  assert.ok(cp.len < base.len - 4 && cp.wid < base.wid - 3, `コンパクト: 縦 ${f(cp.len)} 横 ${f(cp.wid)} (標準 縦 ${f(base.len)} 横 ${f(base.wid)})`);
  assert.ok(lp.wid > base.wid + 0.8, `間延び: 横 ${f(lp.wid)} (標準 ${f(base.wid)})`);
  assert.ok(base.press > 0.8 && wait.press < 0.1, `引いて待つ: 敵陣側にボールがあるときの寄せ役 ${f(wait.press)} 人 (標準 ${f(base.press)} 人)`);
  assert.ok(pp.tkl > pm.tkl * 1.2, `プレス強度: タックル ${pp.tkl} 回（強） ${pm.tkl} 回（弱）`);
  return `最終ライン 高${f(hi.line)} 標準${f(base.line)} 低${f(lo.line)} m／縦幅 コンパクト${f(cp.len)} 標準${f(base.len)} m`;
});


// 切り替え（失った直後・奪った直後）とリスクの集計。チーム0だけに指示を与え、相手は標準
function transStats(tac, seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], minutes = 15) {
  const o = { lost: 0, reg5: 0, n3: 0, near: 0, cen: 0, prog: 0, progN: 0, sb: 0, sbN: 0 };
  for (const seed of seeds) {
    const m = createMatch(sampleInput(seed, { ...OPT, homeTac: tac }));
    let lastC = -1e9, prev = null;
    const p3 = [], p4 = [];
    while (m.t < minutes * 1200 && stepMatch(m)) {
      const cc = m.N[I.CHGT];
      if (cc !== lastC) {
        lastC = cc;
        if (cc >= 0) {
          const w = m.N[I.POSS];
          if (w === 1) { o.lost++; if (m.F[F_B] * dirOf(m.N, 0) > 5) p3.push(cc + 60); } else if (m.slot[m.N[I.OWN]] !== 0) p4.push([cc + 80, m.F[F_B] * dirOf(m.N, 0)]); // GKが取った場合は、配球で前進が決まるので数えない
          if (prev && prev[1] === 1 && w === 0 && cc - prev[0] <= 100) o.reg5++; // 失ったあと 5秒以内に奪い返した
          prev = [cc, w];
        }
      }
      if (p3.length && p3[0] <= m.t) { // 敵陣でボールを失って3秒後: チームの重心（攻める向きを+とした x の平均）と、ボールの 8m 以内にいる人数
        p3.shift();
        const dir = dirOf(m.N, 0);
        for (let i = 1; i < 11; i++) { o.cen += (m.px[i] * dir) / 10; if ((m.px[i] - m.F[F_B]) ** 2 + (m.py[i] - m.F[F_B + 1]) ** 2 < 64) o.near++; }
        o.n3++;
      }
      if (p4.length && p4[0][0] <= m.t) { const [, f0] = p4.shift(); o.prog += m.F[F_B] * dirOf(m.N, 0) - f0; o.progN++; } // 奪って4秒後のボールの前進
      if (m.t % 10 === 0 && m.N[I.PHASE] === PHASE.LIVE && m.N[I.OWN] >= 0 && m.team[m.N[I.OWN]] === 0) { // 攻撃中（ボールが敵陣の奥）に、後ろへ残す優先の2人の位置
        const dir = dirOf(m.N, 0);
        if (m.F[F_B] * dir > 15) { for (let i = 1; i < 11; i++) if (m.rest[i] >= 0 && m.rest[i] < 2) { o.sb += m.px[i] * dir; o.sbN++; } }
      }
    }
  }
  return { reg5: o.reg5 / Math.max(1, o.lost), cen: o.cen / Math.max(1, o.n3), near: o.near / Math.max(1, o.n3), prog: o.prog / Math.max(1, o.progN), sb: o.sb / Math.max(1, o.sbN), lost: o.lost };
}
await test('transition: 切り替え（失った直後・奪った直後）とリスクの指示が動きに効く', () => {
  const b = transStats({}), gp = transStats({ onLose: 1 }), rt = transStats({ onLose: -1 }), rs = transStats({ risk: -1 });
  const S20 = Array.from({ length: 20 }, (_, i) => i + 1); // 奪った直後の前進は、1回ごとのばらつきが大きい（真の差は約 +2m / -3m）ので 20試合で見る
  const bw = transStats({}, S20), v1 = transStats({ onWin: 1 }, S20), v0 = transStats({ onWin: -1 }, S20);
  const f = (x) => x.toFixed(2);
  assert.ok(gp.reg5 > b.reg5 + 0.05, `すぐ奪い返す: 5秒以内に奪い返す割合 ${f(gp.reg5)}（標準 ${f(b.reg5)}）`);
  assert.ok(gp.near > b.near + 0.25, `すぐ奪い返す: 3秒後にボール8m以内にいる人数 ${f(gp.near)}（標準 ${f(b.near)}）`);
  assert.ok(rt.cen < b.cen - 2.5 && gp.cen > b.cen + 1, `敵陣で失って3秒後のチームの重心 すぐ戻る ${f(rt.cen)} 標準 ${f(b.cen)} すぐ奪い返す ${f(gp.cen)}（m）`);
  assert.ok(v1.prog > bw.prog + 0.5 && v0.prog < bw.prog - 1, `奪った直後: 4秒後のボールの前進 縦に速く ${f(v1.prog)} 標準 ${f(bw.prog)} キープ ${f(v0.prog)}（m）`);
  assert.ok(rs.sb < b.sb - 4, `リスクが低い: 敵陣の奥で攻めているとき、後ろへ残す2人の位置 ${f(rs.sb)}（標準 ${f(b.sb)} m）`);
  return `5秒奪回 ${f(gp.reg5)}/${f(b.reg5)}  3秒後の重心 ${f(rt.cen)}/${f(b.cen)}/${f(gp.cen)}  4秒前進 ${f(v1.prog)}/${f(bw.prog)}/${f(v0.prog)}  残す位置 ${f(rs.sb)}/${f(b.sb)}`;
});
// 攻撃の配置の集計。チーム0だけに指示を与え、相手は標準。チーム0が持っている間の、横幅・逆サイドの幅・敵陣最終盤のボールの通り道・後ろに残る人数と、パス（本数・持ち時間・前向き）
function atkStats(tac, seeds = [1, 2, 3, 4, 5, 6, 7, 8], minutes = 10) {
  const o = { n: 0, wid: 0, farN: 0, far: 0, fl: [0, 0, 0], bN: 0, behind: 0, pass: 0, passN: 0, hold: 0, holdN: 0, fwd: 0 };
  for (const seed of seeds) {
    const m = createMatch(sampleInput(seed, { ...OPT, homeTac: tac }));
    let lastK = -1;
    while (m.t < minutes * 1200 && stepMatch(m)) {
      if (m.N[I.KICKT] !== lastK) { // 蹴った。チーム0の外野手のパスなら、持ち時間と向きを数える
        lastK = m.N[I.KICKT];
        const ps = m.N[I.LAST];
        if (m.N[I.RECV] >= 0 && m.N[I.PASSK] === 0 && ps >= 0 && m.team[ps] === 0 && m.slot[ps] !== 0 && m.N[I.PHASE] === PHASE.LIVE) {
          const hold = (lastK - m.N[I.GOT]) * 0.05;
          o.passN++; if ((m.F[F_PASS] - m.F[F_B + 6]) * dirOf(m.N, 0) > 3) o.fwd++;
          if (hold >= 0 && hold < 5) { o.hold += hold; o.holdN++; }
        }
      }
      if (m.t % 10 || m.N[I.PHASE] !== PHASE.LIVE) continue;
      const own = m.N[I.OWN];
      if (own < 0 || m.team[own] !== 0) continue;
      const dir = dirOf(m.N, 0), bfx = m.F[F_B] * dir, by = m.F[F_B + 1];
      let y0 = 99, y1 = -99, bh = 0;
      for (let i = 1; i < 11; i++) {
        y0 = Math.min(y0, m.py[i]); y1 = Math.max(y1, m.py[i]);
        if (bfx > 0 && i !== own && m.px[i] * dir < bfx - 5) bh++;
        if (bfx > 10 && i !== own && Math.abs(by) > 8 && m.py[i] * by < 0 && Math.abs(m.py[i] - by) > 20) { o.far += Math.abs(m.py[i]); o.farN++; }
      }
      if (bfx > 10) { o.n++; o.wid += y1 - y0; }
      if (bfx > 0) { o.bN++; o.behind += bh; }
      if (bfx > 17.5) o.fl[Math.abs(by) > 20.4 ? 0 : Math.abs(by) > 6.8 ? 1 : 2]++;
    }
    o.pass += m.N[I.ST + ST.PASS];
  }
  const fs = o.fl[0] + o.fl[1] + o.fl[2];
  return { wid: o.wid / o.n, far: o.far / Math.max(1, o.farN), wide: o.fl[0] / fs, hs: o.fl[1] / fs, cen: o.fl[2] / fs, behind: o.behind / o.bN, pass: o.pass / seeds.length, hold: o.hold / o.holdN, fwd: o.fwd / o.passN };
}
await test('tactics: 攻撃の指示（幅・テンポ・攻め方・リスク）が配置と判断に効く', () => {
  const S = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const S30 = Array.from({ length: 30 }, (_, i) => i + 1); // v14: テンポは前向きのパスの割合の差が小さい（30試合の測定で 遅33%・標準36%・速39%）ので、30試合で見る
  const b = atkStats({}, S), W1 = atkStats({ width: 1 }, S), W0 = atkStats({ width: -1 }, S), b3 = atkStats({}, S30), T1 = atkStats({ tempo: 1 }, S30), T0 = atkStats({ tempo: -1 }, S30);
  const A1 = atkStats({ attack: 1 }, S), A0 = atkStats({ attack: -1 }, S), R1 = atkStats({ risk: 1 }, S), R0 = atkStats({ risk: -1 }, S);
  const f = (x) => x.toFixed(1), p = (x) => Math.round(100 * x) + '%';
  assert.ok(W1.wid > b.wid + 2.5 && W0.wid < b.wid - 4, `幅: 攻撃中のチームの横幅 広${f(W1.wid)} 標準${f(b.wid)} 狭${f(W0.wid)} m`);
  assert.ok(W1.far > b.far + 1.2 && W0.far < b.far - 1, `幅: 逆サイドの選手の幅 広${f(W1.far)} 標準${f(b.far)} 狭${f(W0.far)} m`);
  assert.ok(W1.hs > b.hs + 0.01, `幅が広い: 敵陣の最終盤でハーフスペースを通る割合 ${p(W1.hs)}（標準 ${p(b.hs)}）`); // 30試合で測ると +4〜5pt（認知なしは +6pt）。10試合ではばらつくので、向きだけ見る
  // テンポ: 40試合で測ると、持ち時間 -0.39 秒（速）、パス本数 速 +27%・遅 -11%。10試合では遅の差が -6〜-15% とぶれるので、向きと下限（-5%）だけ見る
  assert.ok(T1.hold < b3.hold - 0.2 && T0.pass < b3.pass * 0.95, `テンポ: 持ち時間 速${f(T1.hold)} 標準${f(b3.hold)} 秒／パス本数 遅${f(T0.pass)} 標準${f(b3.pass)}（10分あたり）`);
  assert.ok(T1.fwd > T0.fwd + 0.04, `テンポ: 前向きのパスの割合 速${p(T1.fwd)} 遅${p(T0.fwd)}`);
  assert.ok(A1.wide > b.wide + 0.08 && A0.wide < b.wide - 0.03 && A0.cen > A1.cen + 0.2, `攻め方: 敵陣の最終盤で大外を通る割合 サイド${p(A1.wide)} 標準${p(b.wide)} 中央${p(A0.wide)}／中央を通る割合 中央${p(A0.cen)} サイド${p(A1.cen)}`);
  assert.ok(R1.behind < b.behind - 0.5 && R0.behind > b.behind + 0.4, `リスク: 攻撃中にボールより5m以上後ろにいる人数 冒険${f(R1.behind)} 標準${f(b.behind)} 安全${f(R0.behind)}`);
  return `横幅 ${f(W1.wid)}/${f(b.wid)}/${f(W0.wid)}  持ち時間 ${f(T1.hold)}/${f(b.hold)}  大外 ${p(A1.wide)}/${p(b.wide)}/${p(A0.wide)}  後ろに残る ${f(R1.behind)}/${f(b.behind)}/${f(R0.behind)}`;
});
// 組み立て（build）の集計。チーム0だけに指示を与え、相手は標準。チーム0の外野手のグラウンダーのパスについて、本数・ロング（25m超）・後ろ向き（3m超）の割合と、クリア（大きく蹴り出す）の回数を数える
function buildStats(tac, seeds, minutes = 15) {
  const o = { pass: 0, long: 0, fwd: 0, lat: 0, back: 0, clr: 0 };
  for (const seed of seeds) {
    const m = createMatch(sampleInput(seed, { ...OPT, homeTac: tac }));
    let lastK = -1;
    while (m.t < minutes * 1200 && stepMatch(m)) {
      if (m.N[I.KICKT] === lastK) continue;
      lastK = m.N[I.KICKT];
      const ps = m.N[I.LAST];
      if (m.N[I.RECV] < 0 || m.N[I.PASSK] !== 0 || ps < 0 || m.team[ps] !== 0 || m.slot[ps] === 0 || m.N[I.PHASE] !== PHASE.LIVE) continue;
      const dx = (m.F[F_PASS] - m.F[F_B]) * dirOf(m.N, 0), dy = m.F[F_PASS + 1] - m.F[F_B + 1];
      if (dx > 3) o.fwd++; else if (dx < -3) o.back++; else o.lat++;
      if (dx * dx + dy * dy > 625) o.long++;
    }
    o.pass += m.N[I.ST + ST.PASS]; o.clr += m.N[I.ST + ST.CLR];
  }
  const n = seeds.length;
  return { pass: o.pass / n, long: o.long / n, back: o.back / (o.fwd + o.lat + o.back), clr: o.clr / n };
}
await test('tactics: 組み立て（build）— 0 は標準のまま。+1 でロング・クリアが増え、−1 で減って後ろ向きのパスが増える', () => {
  const z = tacParams({}), h = tacParams({ build: -1 }), d = tacParams({ build: 1 });
  const neutral = { longPen: 0.012, longBon: 0, shortB: 0, backB: 0, clrK: 1, clrLoss: 0, gkFx: -22, reliefK: 1 };
  for (const [k, v] of Object.entries(neutral)) assert.equal(z[k], v, k);
  assert.ok(h.longPen > z.longPen && h.shortB > 0 && h.backB > 0 && h.clrK < 1 && h.clrLoss > 0 && h.gkFx > z.gkFx && h.reliefK > 1, 'つなぐ（−1）の向き');
  assert.ok(d.longPen < z.longPen && d.longBon > 0 && d.shortB < 0 && d.clrK > 1 && d.reliefK < 1, '蹴る（+1）の向き');
  const S = [1, 2, 3, 4, 5, 6, 7, 8];
  const b = buildStats({}, S), h1 = buildStats({ build: -1 }, S), d1 = buildStats({ build: 1 }, S);
  const f = (x) => x.toFixed(1), p = (x) => Math.round(100 * x) + '%';
  // 8試合×15分で測ると ロング 1.8/3.1/7.4（0.6倍・2.4倍）、クリア 10.4/14.9/17.1、後ろ向き 38%/32%/32%、パス 182/142/104。ばらつくので、向きと余裕のある下限だけ見る
  assert.ok(h1.long < b.long * 0.8 && d1.long > b.long * 1.5, `ロング(25m超)のパス つなぐ${f(h1.long)} 標準${f(b.long)} 蹴る${f(d1.long)}`);
  assert.ok(h1.clr < b.clr * 0.9 && d1.clr > b.clr, `クリア つなぐ${f(h1.clr)} 標準${f(b.clr)} 蹴る${f(d1.clr)}`);
  assert.ok(h1.back > b.back + 0.03, `後ろ向きのパスの割合 つなぐ${p(h1.back)} 標準${p(b.back)}`);
  assert.ok(h1.pass > b.pass * 1.15 && d1.pass < b.pass * 0.85, `パス本数 つなぐ${f(h1.pass)} 標準${f(b.pass)} 蹴る${f(d1.pass)}`);
  return `ロング ${f(h1.long)}/${f(b.long)}/${f(d1.long)}  クリア ${f(h1.clr)}/${f(b.clr)}/${f(d1.clr)}  後ろ向き ${p(h1.back)}/${p(b.back)}/${p(d1.back)}  パス ${f(h1.pass)}/${f(b.pass)}/${f(d1.pass)}（−1/0/+1。8試合の15分あたり）`;
});
await test('styles: チームの戦い方の型（標準・保持・直接）は、指示の項目と範囲に合っている', () => {
  const keys = new Set(TACTICS.map((d) => d.key));
  assert.deepEqual(Object.keys(STYLES), ['std', 'hold', 'direct']);
  assert.deepEqual(STYLES.std.tac, {}, '標準は指示なし');
  for (const [id, st] of Object.entries(STYLES)) {
    assert.ok(typeof st.name === 'string' && st.name.length > 0, id + ' の名前');
    for (const [k, v] of Object.entries(st.tac)) assert.ok(keys.has(k) && TACTICS.find((d) => d.key === k).on && v >= -1 && v <= 1, `${id}.${k}=${v}`);
  }
  assert.ok(STYLES.hold.tac.build < 0 && STYLES.direct.tac.build > 0, 'つなぐ型は build が負、直接は正');
});
await test('tactics: 攻撃の指示を0にすると、数値は標準のまま（全部の倍率が1・加点が0）。±1でその向きに動く', () => {
  const z = tacParams({});
  const keep = { wideK: 1, farShift: 0.12, supR: 11, hsK: 0, btwK: 0, reactK: 1, passCost: 0.01, hold0: 1.5, supPc: 0.55, latK: 0, wingK: 1, sbUpK: 1, lossK: 1, shtK: 1, push: 0, runPlus: 0 };
  for (const [k, v] of Object.entries(keep)) assert.equal(z[k], v, k);
  const a = tacParams({ width: 1, tempo: 1, attack: 1, risk: 1 }), c = tacParams({ width: -1, tempo: -1, attack: -1, risk: -1 });
  assert.ok(a.wideK > 1 && a.farShift < 0.12 && a.hsK > 0 && a.reactK < 1 && a.passCost < 0.01 && a.latK > 0 && a.lossK < 1 && a.shtK > 1 && a.push > 0 && a.runPlus === 1);
  assert.ok(c.wideK < 1 && c.farShift > 0.12 && c.hsK === 0 && c.reactK > 1 && c.passCost > 0.01 && c.latK < 0 && c.lossK > 1 && c.shtK < 1 && c.push < 0 && c.runPlus === -1);
});
await test('transition: 切り替えの指示を0にすると窓が開かない（loseW/winW = 0、tacT なし）。指示があるとき窓の長さは最大 6 秒', () => {
  const z = tacParams({ onLose: 0, onWin: 0, risk: 0 });
  assert.equal(z.loseW, 0); assert.equal(z.winW, 0); assert.equal(z.tacT, null); assert.equal(z.restN, 0); assert.equal(z.tuckK, 1);
  const a = tacParams({ onLose: 1, onWin: -1 });
  assert.equal(a.loseW, 120); assert.equal(a.winW, 120); assert.equal(a.tacT.nPress, 3);
  assert.equal(tacParams({ onLose: -1 }).loseW, 80);
});

// スタミナ
await test('stamina: 万全で始まり、走ると減る。ハーフタイムで少し回復し、STMが高いほど減りにくい。控えは万全で出る', () => {
  const m = mk(1);
  for (let i = 0; i < NP; i++) assert.equal(m.F[F_STA + i], 1);
  run(m, 20 * 1200);
  const a20 = staminaOf(m, 0);
  assert.ok(a20 < 0.97 && a20 > 0.5, `20分後 ${a20.toFixed(2)}`);
  const h = mk(2);
  run(h, h.pEnd[0] - 1);
  const before = staminaOf(h, 1);
  run(h, h.pEnd[0] + 2);
  assert.ok(staminaOf(h, 1) > before + 0.1, `ハーフタイムの回復 ${before.toFixed(2)} → ${staminaOf(h, 1).toFixed(2)}`);
  const inp = sampleInput(3, OPT);
  for (const [k, st] of [[0, 20], [1, 1]]) inp.teams[k].players.forEach((p) => { const v = Array.from(abVec(p.ab)); v[AB.STM] = st; p.ab = v; });
  const e = createMatch(inp);
  run(e, 20 * 1200);
  assert.ok(staminaOf(e, 0) > staminaOf(e, 1) + 0.05, `STM 20: ${staminaOf(e, 0).toFixed(2)} / STM 1: ${staminaOf(e, 1).toFixed(2)}`);
  const sb = sampleInput(1, OPT);
  sb.changes = [{ t: 600, k: 0, type: 'sub', slot: 9, bench: 2 }];
  const s = createMatch(sb);
  const ev = run(s, Infinity, { [EV.SUB]: true });
  assert.ok(ev && ev[5] === 1);
  assert.equal(s.F[F_STA + 9], 1, '控えは万全で出る');
  assert.ok(s.F[F_STA + 8] < 1);
  return `20分後 ${a20.toFixed(2)}、STM20 ${staminaOf(e, 0).toFixed(2)} / STM1 ${staminaOf(e, 1).toFixed(2)}`;
});
await test('stamina: 疲れるほど遅くなる（最高速度・加速度）。強く走り回るチームほど後半に疲れている', () => {
  const m = mk(4);
  const v0 = m.vmax[5];
  assert.equal(v0, m.vmax0[5]);
  run(m, 30 * 1200);
  assert.ok(m.F[F_STA + 5] < 1 && m.vmax[5] < m.vmax0[5] && m.acc[5] < m.acc0[5]);
  let a = 0, b = 0;
  for (const seed of [1, 2, 3]) {
    const s0 = createMatch(sampleInput(seed, OPT)), s1 = createMatch(sampleInput(seed, { ...OPT, homeTac: { onLose: 1, pressPower: 0.5 } }));
    run(s0, 30 * 1200); run(s1, 30 * 1200);
    a += staminaOf(s0, 0) / 3; b += staminaOf(s1, 0) / 3;
  }
  assert.ok(b < a - 0.05, `標準 ${a.toFixed(2)}、ゲーゲンプレス+強いプレス ${b.toFixed(2)}`);
  return `30分後: 標準 ${a.toFixed(2)}、ゲーゲンプレス+強いプレス ${b.toFixed(2)}`;
});

// ゴール前の判断: 場面を作って、保持者(me)の最初の判断を調べる。座標は攻める向きを+にした (x, y)。
// mate=フリーの味方、opp=相手の外野手（相手のGKは (51.5, 0)）。ほかの選手は遠くに散らす。
// 認知あり（既定）のときは、保持者の体の向き（look: 'goal'=ゴールのほう（既定）・'mate'=味方のほう）と、気づき（scn。省略は今の値）も決める。
function nearGoalChoice(seed, sc) {
  const m = mk(seed, { home: '4-4-2', away: '4-4-2', abilHome: 10, abilAway: 10 });
  const dir = dirOf(m.N, 0), me = 9, mate = 8;
  for (let i = 0; i < NP; i++) { const s = i % 11; m.px[i] = (-10 - 1.5 * s) * dir; m.py[i] = (-24 + 4.8 * s) * (i < 11 ? 1 : -1); m.vx[i] = 0; m.vy[i] = 0; }
  m.px[11] = 51.5 * dir; m.py[11] = 0;
  const put = (i, p) => { m.px[i] = p[0] * dir; m.py[i] = p[1] * dir; };
  put(me, sc.me); put(mate, sc.mate); sc.opp.forEach((p, n) => put(12 + n, p));
  m.F[F_B] = m.px[me]; m.F[F_B + 1] = m.py[me]; m.F[F_B + 2] = BALL_R; m.F[F_B + 3] = 0; m.F[F_B + 4] = 0; m.F[F_B + 5] = 0;
  m.N[I.OWN] = me; m.N[I.POSS] = 0; m.N[I.SETP] = SP.NONE; m.N[I.RECV] = -1; m.N[I.GOT] = 0;
  m.t = 800 + 53 * seed;
  if (m.pOn) {
    m.F[F_FACE + me] = sc.look === 'mate' ? M.atan2(m.py[mate] - m.py[me], m.px[mate] - m.px[me]) : dir > 0 ? 0 : M.PI;
    if (sc.scn !== undefined) m.F[F_SCN + me] = sc.scn;
    refreshFace(m);
  }
  const s0 = m.N[I.SHOTS];
  decide(m, me);
  if (m.N[I.SHOTS] > s0) return 'shot';
  if (m.N[I.RECV] >= 0) return HL - m.F[F_PASS] * dir > 15 ? 'far' : 'pass'; // far = ゴールから15m超の味方へのパス
  return 'carry';
}
await test('shoot: ゴール前で撃てる場面では撃つ（遠い味方へのパスに逃げない）。撃つ角度が無いときは、中央のフリーの味方へ出す', () => {
  const N = 40, tally = (sc) => { const c = { shot: 0, far: 0, pass: 0, carry: 0 }; for (let s = 1; s <= N; s++) c[nearGoalChoice(s, sc)]++; return c; };
  const free = tally({ me: [46.5, 1], mate: [36, -1], opp: [] }); // 正面6m・相手なし
  const crowd = tally({ me: [47.5, 0.5], mate: [37, -1], opp: [[47.2, 2.0], [46.9, -1.0], [49.5, 0.3], [50.5, 1.0]] }); // 正面5m: 両脇に密着2人＋コースに2人
  const lane = tally({ me: [43.5, -1], mate: [33, 2], opp: [[47, -0.6]] }); // 正面9m・コースに1人
  const byline = tally({ me: [50.5, 9], mate: [45, 0], opp: [[50, 10.2]], look: 'mate' }); // ゴールライン際の脇（ほぼ撃てない）・中央にフリーの味方（中を見ている）
  assert.equal(free.shot, N, `相手なし: 撃つ ${free.shot}/${N}`);
  assert.ok(crowd.shot >= N * 0.8 && crowd.far <= N * 0.15, `5m・密着2人＋コース2人: 撃つ ${crowd.shot}/${N}、遠い味方へ ${crowd.far}`);
  assert.ok(lane.shot >= N * 0.85, `9m・コースに1人: 撃つ ${lane.shot}/${N}`);
  assert.ok(byline.pass >= N * 0.7, `ゴールライン際の脇: 味方へのパス ${byline.pass}/${N}`);
  return `撃つ割合 相手なし ${free.shot}/${N}、5m密着 ${crowd.shot}/${N}、9m ${lane.shot}/${N}、ライン際で味方へ ${byline.pass}/${N}`;
});

// ── 認知（向き・視野・気づき。engine/percept.js）──
await test('percept: 認知は既定でつく（percept: 0 で外せる）。同じ入力は同じ結果で、途中の保存→復元→再開も通しと一致', () => {
  const input = sampleInput(6, { ...OPT, rules: SHORT }), off = sampleInput(6, { ...OPT, rules: SHORT, percept: 0 });
  const ref = createMatch(input), o = createMatch(off);
  assert.equal(ref.pOn, 1); assert.equal(o.pOn, 0);
  assert.equal(ref.F.length, F_LEN_P); assert.equal(o.F.length, F_LEN, '認知なしは従来の長さの状態');
  assert.equal(frame(o).face, null); assert.equal(frame(ref).face.length, NP);
  run(ref, 2500);
  const snap = snapshot(ref);
  run(ref);
  const D = digestMatch(ref);
  restore(ref, snap); run(ref);
  assert.equal(digestMatch(ref), D, '同じ箱');
  const fresh = createMatch(input);
  restore(fresh, snap); run(fresh);
  assert.equal(digestMatch(fresh), D, '新しい箱');
  const viaJson = createMatch(input);
  restore(viaJson, JSON.parse(JSON.stringify(snapshotToJSON(snap)))); run(viaJson);
  assert.equal(digestMatch(viaJson), D, 'JSON経由');
  const again = createMatch(input); run(again);
  assert.equal(digestMatch(again), D, '同じ入力は同じ結果');
  run(o);
  assert.notEqual(digestMatch(o), D, '認知なしは別の展開');
});
await test('percept: 体の向きは、能力で決まる速さでしか変わらない。走っている選手は進む向きを向く', () => {
  const m = mk(3);
  const pf = Float64Array.from(m.F.subarray(F_FACE, F_FACE + NP));
  let maxTurn = 0, n = 0, al = 0, lp = m.N[I.PHASE];
  while (m.t < 6000 && stepMatch(m)) {
    const live = lp === PHASE.LIVE && m.N[I.PHASE] === PHASE.LIVE; // キックオフの並べ直しでは、全員がボールのほうへ向き直る
    lp = m.N[I.PHASE];
    for (let i = 0; i < NP; i++) {
      const a = m.F[F_FACE + i];
      if (live) maxTurn = Math.max(maxTurn, Math.abs(M.wrapAngle(a - pf[i])) / m.wTurn[i]);
      pf[i] = a;
      const sp = Math.sqrt(m.vx[i] * m.vx[i] + m.vy[i] * m.vy[i]);
      if (live && m.t % 10 === 0 && sp > 5) { n++; al += (m.vx[i] * m.fcx[i] + m.vy[i] * m.fcy[i]) / sp; }
    }
  }
  assert.ok(maxTurn <= 1.0001, `1 tick に向きを変えた量は上限の ${maxTurn.toFixed(3)} 倍`);
  assert.ok(n > 300 && al / n > 0.8, `5m/s を超えて走っている選手の、向きと進む向きの一致（cos の平均） ${(al / Math.max(1, n)).toFixed(2)}（${n} 件）`);
  return `向きの変化は上限の ${maxTurn.toFixed(2)} 倍まで、走っているときの向きの一致 ${(al / n).toFixed(2)}`;
});
await test('percept: 視野（正面は見え、背後は見えない・広さは能力「視野」・すぐそばは気配で分かる）と、気づき・見えていない相手の扱い', () => {
  const inp = sampleInput(2, OPT);
  for (const [k, s] of [[0, 1], [1, 20]]) inp.teams[k].players.forEach((p) => { const v = Array.from(abVec(p.ab)); v[AB.VIS] = s; v[AB.ANT] = s; p.ab = v; }); // チーム0は視野1・予測1、チーム1は視野20・予測20
  const m = createMatch(inp);
  const put = (i, x, y) => { m.px[i] = x; m.py[i] = y; m.vx[i] = 0; m.vy[i] = 0; };
  const face = (i, a, scn) => { m.F[F_FACE + i] = a; m.F[F_SCN + i] = scn; refreshFace(m); };
  const at = (i, x, y) => seeAt(m, i, m.px[i] + x, m.py[i] + y);
  for (const [i, wide] of [[5, false], [16, true]]) {
    put(i, 0, 0); face(i, 0, 0); // +x を向いている・周りを確認していない
    assert.equal(at(i, 10, 0), 1, '正面は見える');
    assert.equal(at(i, -10, 0), 0, '背後（遠い）は見えない');
    assert.equal(at(i, -1, 0), 1, 'すぐそばは気配で分かる');
    const nz = at(i, -3, 0);
    assert.ok(nz > 0.3 && nz < 0.9, `背後 3m は少し分かる ${nz.toFixed(2)}`);
    assert.equal(at(i, -7, 0), 0, '背後 7m は分からない');
    const c = M.cos(100 * M.PI / 180), sn = M.sin(100 * M.PI / 180);
    assert.equal(at(i, 10 * c, 10 * sn) === 1, wide, `斜め後ろ 100° の 10m: 視野${wide ? 20 : 1} → ${at(i, 10 * c, 10 * sn).toFixed(2)}`);
    face(i, 0, 0.5);
    assert.equal(senseAt(m, i, m.px[i] - 10, m.py[i]), 0.5, '気づき 0.5 なら、見えていない範囲も 5 割は把握している（相手の位置の把握に使う）');
    assert.equal(at(i, -10, 0), 0, '首を振って確認しても、見えたことにはならない（パスの候補には入らない）');
  }
  // seeAll: 見えていない味方は（見たことがなければ）0（出せない）、見えていない相手は 0.4（気配・チームの動きから）、自分は 1
  put(5, 0, 0); face(5, 0, 0);
  put(4, -20, 0); put(15, -20, 5); put(3, 20, 0); put(14, 20, 5);
  for (let j = 0; j < NP; j++) if (![5, 4, 15, 3, 14].includes(j)) put(j, -45, 30 - 2 * j);
  m.N.fill(NEVER_SEEN, N_LS); // キックオフで全員が覚えている状態を消す
  const aw = seeAll(m, 5);
  assert.equal(aw[5], 1); assert.equal(aw[4], 0, '見えていない味方（見たことがない）'); assert.ok(Math.abs(aw[15] - 0.4) < 1e-9, `見えていない相手 ${aw[15]}`);
  assert.equal(aw[3], 1); assert.equal(aw[14], 1);
  // 見えていない相手に気づくまでの遅れ（予測の高い選手ほど短い）。見えていれば 0
  assert.ok(lagOf(m, 5, 15) > 0.45 && lagOf(m, 5, 15) <= 0.5, `予測1の遅れ ${lagOf(m, 5, 15).toFixed(2)}`);
  assert.equal(lagOf(m, 5, 14), 0);
  put(16, 0, 0); face(16, 0, 0); put(4, -20, 0);
  assert.ok(lagOf(m, 16, 4) < 0.25 && lagOf(m, 16, 4) >= 0.15, `予測20の遅れ ${lagOf(m, 16, 4).toFixed(2)}`);
  assert.ok(m.fov[16] > m.fov[5] + 0.8, `視野の半角 視野20 ${(m.fov[16] * 57.3).toFixed(0)}° / 視野1 ${(m.fov[5] * 57.3).toFixed(0)}°`);
});
await test('percept: ボールを持っている選手は扇が狭い（すぐそばの気配は同じ）。気配で分かる距離は、味方 10m・相手 6m', () => {
  const inp = sampleInput(2, OPT);
  inp.teams[0].players.forEach((p) => { const v = Array.from(abVec(p.ab)); v[AB.VIS] = 10; p.ab = v; });
  const m = createMatch(inp);
  for (let i = 0; i < NP; i++) { m.px[i] = -45; m.py[i] = 30 - 2 * i; m.vx[i] = m.vy[i] = 0; }
  m.px[5] = 0; m.py[5] = 0; m.F[F_FACE + 5] = 0; m.F[F_SCN + 5] = 0; refreshFace(m);
  const ang = (deg, d) => [d * M.cos(deg * M.PI / 180), d * M.sin(deg * M.PI / 180)];
  const see = (deg, d) => { const [x, y] = ang(deg, d); return seeAt(m, 5, x, y); };
  m.N[I.OWN] = 15; // 5 はボールを持っていない
  const free = { a40: see(40, 10), a80: see(80, 10), a100: see(100, 10), back3: see(180, 3), fov: fovOf(m, 5) };
  m.N[I.OWN] = 5; // 5 がボールを持つ
  const held = { a40: see(40, 10), a80: see(80, 10), a100: see(100, 10), back3: see(180, 3), fov: fovOf(m, 5) };
  assert.equal(free.a40, 1); assert.equal(held.a40, 1, '正面寄り（40°）はどちらも見える');
  assert.ok(free.a80 > held.a80 + 0.5, `斜め 80°: 持っていない ${free.a80.toFixed(2)} / 持っている ${held.a80.toFixed(2)}`);
  assert.ok(free.a100 > 0.1 && held.a100 === 0, `斜め後ろ 100°: 持っていない ${free.a100.toFixed(2)} / 持っている ${held.a100.toFixed(2)}`);
  assert.equal(held.back3, free.back3, 'すぐそばの気配は、持っていても変わらない');
  assert.ok(held.fov < free.fov * 0.85 && held.fov > free.fov * 0.7, `視野の半角 持っていない ${(free.fov * 57.3).toFixed(0)}° / 持っている ${(held.fov * 57.3).toFixed(0)}°`);
  assert.equal(held.fov, m.fov[5] * 0.8, '保持者の扇は 0.8 倍');
  // 気配で分かる距離: 味方は 10m まで（8m 後ろの味方がパスの候補になれる）、相手は 6m まで。見たことのない味方で調べる
  m.N.fill(NEVER_SEEN, N_LS);
  m.N[I.OWN] = 15;
  m.px[4] = -8; m.py[4] = 0; m.px[3] = -11; m.py[3] = 0; m.px[14] = -8; m.py[14] = 3; m.px[13] = -3; m.py[13] = -1;
  const aw = seeAll(m, 5);
  assert.ok(aw[4] > 0.15 && aw[4] < 0.4, `8m 後ろの味方 ${aw[4].toFixed(2)}`);
  assert.equal(aw[3], 0, '11m 後ろの味方（見たことがない）は分からない');
  assert.ok(Math.abs(aw[14] - 0.4) < 1e-9, `8m 後ろの相手は気配の外（下限 0.4） ${aw[14].toFixed(2)}`);
  assert.ok(aw[13] > 0.7, `3.2m 後ろの相手は気配の中 ${aw[13].toFixed(2)}`);
  return `扇の半角 ${(free.fov * 57.3).toFixed(0)}° → 保持者 ${(held.fov * 57.3).toFixed(0)}°（斜め 80° の見え方 ${free.a80.toFixed(2)} → ${held.a80.toFixed(2)}）`;
});
await test('percept: 視野で見た味方は少しのあいだ覚えている（気づきが高いほど長く）。再開の最初のプレーは全員が分かる。視野に入れれば覚え直す', () => {
  const m = mk(2);
  for (let i = 0; i < NP; i++) { m.px[i] = -45; m.py[i] = 30 - 2 * i; m.vx[i] = m.vy[i] = 0; }
  m.px[5] = 0; m.py[5] = 0; m.px[4] = -20; m.py[4] = 0; // 4 は 5 の背後
  m.t = 2000; m.F[F_FACE + 5] = 0; refreshFace(m); m.N.fill(NEVER_SEEN, N_LS);
  const mem = (scn, ticks) => { m.F[F_SCN + 5] = scn; m.N[N_LS + 5 * NP + 4] = m.t - ticks; return memOf(m, 5, 4); };
  // 覚えていられる長さ = 3 秒 ×（0.3 + 0.7 × 気づき）。気づき 0 で 0.9 秒、1 で 3 秒
  assert.equal(mem(0, 0), 1);
  assert.ok(Math.abs(mem(0, 9) - 0.5) < 1e-9 && mem(0, 18) === 0 && mem(0, 100) === 0, '気づき 0: 0.9 秒で消える');
  assert.ok(Math.abs(mem(1, 30) - 0.5) < 1e-9 && mem(1, 60) === 0, '気づき 1: 3 秒で消える');
  assert.ok(mem(1, 20) > mem(0, 9), '気づきが高いほど長く覚えている');
  assert.equal(memOf(m, 5, 4) >= 0, true);
  // 覚えている味方はパスの候補になれる（見えていなくても）。見たことがない味方は候補にならない
  m.F[F_SCN + 5] = 0; m.N[N_LS + 5 * NP + 4] = m.t - 9;
  const a1 = seeAll(m, 5)[4];
  assert.ok(Math.abs(a1 - 0.5) < 1e-9, `0.45 秒前に見た味方 ${a1}`);
  m.N[N_LS + 5 * NP + 4] = NEVER_SEEN;
  assert.equal(seeAll(m, 5)[4], 0, '見たことがない');
  // 再開（キックオフ・セットプレー）の最初のプレーは、見渡す時間があるので味方の全員が分かる。相手は変わらない
  const awF = seeAll(m, 5, true);
  assert.equal(awF[4], 1, '見ていない味方も分かっている'); assert.equal(awF[3], 1);
  assert.ok(awF[15] < 1, '相手は見渡しても全員は分からない');
  // キックオフでは、味方の全員を覚えた状態で始まる（相手のチームの選手のことは覚えない）
  const k = mk(3);
  assert.equal(memOf(k, 5, 4), 1, 'キックオフ直後の味方'); assert.equal(k.N[N_LS + 5 * NP + 15], NEVER_SEEN, '相手は覚えるものではない');
  // 視野に入れたら、その tick を覚え直す（look が更新する）
  m.px[4] = 15; m.py[4] = 0; m.vx[5] = m.vy[5] = 0; m.N[I.OWN] = 15;
  look(m);
  assert.equal(m.N[N_LS + 5 * NP + 4], m.t, '視野に入っている味方は、見た時刻が更新される');
  m.px[4] = -30; m.t += 20;
  look(m);
  assert.equal(m.N[N_LS + 5 * NP + 4], m.t - 20, '視野から外れたら更新されない');
});
await test('percept: ボールを持っている選手は、見えていない側（扇の外）から寄せられると、ボールを守れない（首を振って確認していれば備えられる）', () => {
  const m = mk(2);
  for (let i = 0; i < NP; i++) { m.px[i] = -45; m.py[i] = 30 - 2 * i; m.vx[i] = m.vy[i] = 0; }
  m.px[9] = 0; m.py[9] = 0; m.F[F_FACE + 9] = 0; m.F[F_SCN + 9] = 0; refreshFace(m); m.N[I.OWN] = 9;
  const put = (j, x, y) => { m.px[j] = x; m.py[j] = y; };
  put(15, 3, 0); put(16, -3, 0); put(17, 1.5, -2); // 正面・真後ろ・ほぼ正面の斜め
  assert.equal(blindOf(m, 9, 15), 0, '正面から寄せる相手は見えている');
  assert.equal(blindOf(m, 9, 16), 1, '真後ろから寄せる相手は気づいていない');
  assert.ok(blindOf(m, 9, 17) < 0.05);
  m.F[F_SCN + 9] = 0.6;
  assert.ok(Math.abs(blindOf(m, 9, 16) - 0.4) < 1e-9, '首を振って確認していれば（気づき 0.6）、備えられる分だけ軽くなる');
  m.F[F_SCN + 9] = 1;
  assert.equal(blindOf(m, 9, 16), 0, '気づき 1 なら、背後も分かっている');
  // 認知なしでは、この影響はない
  const o = createMatch(sampleInput(2, { ...OPT, percept: 0 }));
  assert.equal(o.pOn, 0);
});
await test('percept: 気づきは、自由な選手ほど高く、ボールを持って寄せられている選手・ボールの近くで守る選手ほど低い', () => {
  const run1 = (setup) => { // 22 人を遠くに離して置き、場面だけ作って 15 秒ぶん気づきを更新する（動かさない）
    const m = mk(1);
    stepMatch(m);
    for (let i = 0; i < NP; i++) { m.px[i] = -50 + 3.2 * (i % 11); m.py[i] = i < 11 ? -30 : 30; m.vx[i] = 0; m.vy[i] = 0; m.tx[i] = m.px[i]; m.ty[i] = m.py[i]; m.F[F_SCN + i] = 0.5; }
    setup(m);
    m.F[F_B] = m.px[m.N[I.OWN]]; m.F[F_B + 1] = m.py[m.N[I.OWN]];
    for (let k = 0; k < 300; k++) look(m);
    return m;
  };
  const press = run1((m) => { m.N[I.OWN] = 8; m.N[I.POSS] = 0; m.px[8] = 0; m.py[8] = 0; m.px[12] = 1; m.py[12] = 0; m.tx[8] = 0; m.ty[8] = 0; });
  const freeH = run1((m) => { m.N[I.OWN] = 8; m.N[I.POSS] = 0; m.px[8] = 0; m.py[8] = 0; m.tx[8] = 0; m.ty[8] = 0; });
  const guard = run1((m) => { m.N[I.OWN] = 12; m.N[I.POSS] = 1; m.px[12] = 0; m.py[12] = 0; m.px[9] = 4; m.py[9] = 0; m.tx[12] = 0; m.ty[12] = 0; });
  const a = press.F[F_SCN + 8], b = freeH.F[F_SCN + 8], c = freeH.F[F_SCN + 4], d = guard.F[F_SCN + 9], e = guard.F[F_SCN + 5];
  assert.ok(a < 0.45, `寄せられている保持者 ${a.toFixed(2)}`);
  assert.ok(b > a + 0.3 && b > 0.65, `自由な保持者 ${b.toFixed(2)}`);
  assert.ok(c > 0.95, `自由な味方（ボールを持っているチーム） ${c.toFixed(2)}`);
  assert.ok(d < 0.25, `ボールの近く（4m）で守る選手 ${d.toFixed(2)}`);
  assert.ok(e > d + 0.3, `ボールから遠い（25m 以上）守備の選手 ${e.toFixed(2)}`);
  return `寄せられた保持者 ${a.toFixed(2)}／自由な保持者 ${b.toFixed(2)}／自由な味方 ${c.toFixed(2)}／ボール近くの守備 ${d.toFixed(2)}／遠い守備 ${e.toFixed(2)}`;
});
await test('percept: ボールを持った選手は、視野の外（気づきも 0）の味方にはパスを出さない。中を見ていれば出す', () => {
  const N = 40, byline = { me: [50.5, 9], mate: [45, 0], opp: [[50, 10.2]] };
  let blind = 0, seen = 0;
  for (let s = 1; s <= N; s++) {
    if (nearGoalChoice(s, { ...byline, look: 'goal', scn: 0 }) === 'pass') blind++;
    if (nearGoalChoice(s, { ...byline, look: 'mate', scn: 0 }) === 'pass') seen++;
  }
  assert.equal(blind, 0, `ゴールのほうを向いて、気づき 0: 中央の味方へのパス ${blind}/${N}`);
  assert.ok(seen >= N * 0.9, `中央の味方のほうを向いている: パス ${seen}/${N}`);
  return `視野の外の味方へのパス ${blind}/${N}、見えている味方へのパス ${seen}/${N}`;
});
await test('percept: 認知ありは、見えていない味方へ出せないぶん、認知なしよりパスが減る', () => {
  // 24試合で測ると -12%（1試合ごとの比は ±12% ぶれるので、12試合で見る）
  let on = 0, off = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const a = createMatch(sampleInput(seed, OPT)), b = createMatch(sampleInput(seed, { ...OPT, percept: 0 }));
    run(a, 24000); run(b, 24000);
    on += a.N[I.ST + ST.PASS]; off += b.N[I.ST + ST.PASS];
  }
  assert.ok(on < off * 0.95, `パス数 認知あり ${on} / 認知なし ${off}`);
  return `20分×12試合のパス数 認知あり ${on} / 認知なし ${off}（${Math.round(100 * (on / off - 1))}%）`;
});

// ── 決まりごとの検査 ──
const walk =(d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
await test('lint: engine/ に決定性を壊す記述（Math.sin/pow/random、**、時刻、画面への依存）がない', () => {
  const BAN = [
    [/\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|random)\b/, 'Math の超越関数・random'],
    [/\*\*/, '累乗演算子 **'],
    [/\b(Date|performance)\b/, '時刻'],
    [/from\s+['"]\.\.\/(render|ui|tools|sim)\b/, 'engine から画面・ツールへの依存'],
  ];
  const bad = [];
  const files = walk(fileURLToPath(new URL('../engine/', import.meta.url)));
  for (const f of files) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const [re, why] of BAN) if (re.test(src)) bad.push(`${f}: ${why}`);
  }
  assert.deepEqual(bad, []);
  return files.length + ' ファイルを検査';
});

// ── v14: 予測・指示変更の記録・得点者とアシスト・チェック値・自己診断（エンジンのレビューで見つかった土台の直し）──
await test('predict: ボールの軌道の予測が実際の物理と合う（浮き球の落下点・転がり）。蹴ってから時間が経っても、最初の点に届く人が増えない', () => {
  const cases = { 'ロブ 20m/s': [-10, 5, 0.3, 20, -3, 8], 'クリア 30m/s': [-30, 0, 0.3, 28, 6, 13], 'グラウンダー 15m/s': [-20, 0, BALL_R, 15, 2, 0], '浮き球 14m/s': [0, -10, 0.3, 8, 11, 6] };
  const notes = [];
  for (const [nm, b] of Object.entries(cases)) {
    const m = mk(3);
    for (let q = 0; q < 6; q++) m.F[F_B + q] = b[q];
    m.N[I.OWN] = -1; m.N[I.RECV] = -1; m.N[I.KICKT] = m.t;
    predictBall(m);
    const A = Float64Array.from(b);
    let md = 0, mz = 0;
    for (let s = 1; s <= PRED_N; s++) {
      for (let q = 0; q < PRED_TICKS; q++) stepBall(A, 0, DT);
      const cx = Math.max(-HL, Math.min(HL, A[0])), cy = Math.max(-HW, Math.min(HW, A[1]));
      md = Math.max(md, Math.hypot(m.bpx[s] - cx, m.bpy[s] - cy)); mz = Math.max(mz, Math.abs(m.bpz[s] - A[2]));
    }
    assert.ok(md < 0.3, `${nm}: 位置のずれ ${md.toFixed(2)}m（v13は浮き球で 5〜12m 手前だった）`);
    assert.ok(mz < 0.05, `${nm}: 高さのずれ ${mz.toFixed(2)}m`);
    notes.push(md.toFixed(2));
  }
  const m = mk(3); // ゆっくり転がるボール。蹴ってから4秒たっても、0.25秒後の点に届く人は（近くにいない限り）いない
  m.F[F_B] = 0; m.F[F_B + 1] = 0; m.F[F_B + 2] = BALL_R; m.F[F_B + 3] = 4; m.F[F_B + 4] = 0; m.F[F_B + 5] = 0;
  m.N[I.OWN] = -1; m.N[I.RECV] = -1; m.N[I.KICKT] = m.t - 80;
  predictBall(m);
  let n = 0;
  for (let i = 0; i < NP; i++) if (m.icT[i] <= 0.25) n++;
  assert.ok(n <= 2, `最初の点に届く人 ${n}人（v13は経過時間を足していたので約9人）`);
  return `位置のずれ(m) ${notes.join('/')}・経過4秒で最初の点に届く人 ${n}`;
});

await test('tactics: 試合中の指示変更は入力に記録される。記録から再生しても、途中の保存から復元しても、通しと一致する。呼び出し側の入力は複製される', () => {
  const END = 7200, run2 = (m, to) => { while (m.t < to && stepMatch(m)); };
  const inp = sampleInput(5, { rules: { half: 3, et: 0, pk: false, ko: false } });
  const a = createMatch(inp);
  run2(a, 2400); setTactics(a, 0, { press: 1, tempo: 1, line: 1 });
  run2(a, 4800); const snap = snapshot(a); setTactics(a, 1, { build: -1, risk: -1 });
  run2(a, END);
  const D = digestMatch(a);
  assert.equal(a.input.changes.length, 2, '指示変更が2件、入力に記録されている');
  assert.equal(a.N[I.TACI], 2);
  const b = createMatch(a.input); run2(b, END);
  assert.equal(digestMatch(b), D, '記録（最初の入力＋変更）から再生した結果が通しと一致する');
  const c = createMatch(a.input); restore(c, snap); run2(c, END);
  assert.equal(digestMatch(c), D, '途中（指示変更の間）の保存から、新しい試合へ復元して再開しても一致する');
  const d = createMatch(a.input); run2(d, 1200); const s2 = snapshot(d); run2(d, END);
  const e = createMatch(a.input); restore(e, s2); run2(e, END);
  assert.equal(digestMatch(e), digestMatch(d), '最初の指示変更より前の保存から復元しても一致する');
  assert.equal(digestMatch(d), D);
  const n0 = createMatch(inp); run2(n0, END);
  assert.notEqual(digestMatch(n0), D, '指示変更が効いている（変えなかった試合と結果が違う）');
  // 呼び出し側があとで入力を書き換えても、作った試合には影響しない
  const inp2 = sampleInput(5, { rules: { half: 3, et: 0, pk: false, ko: false } }), f = createMatch(inp2);
  inp2.teams[0].players[3].ab = 1; inp2.teams[0].tactics = { press: -1 };
  const g = createMatch(sampleInput(5, { rules: { half: 3, et: 0, pk: false, ko: false } }));
  run2(f, 3000); run2(g, 3000);
  assert.equal(digestMatch(f), digestMatch(g));
  // 入力に最初から書いた指示変更は、setTactics と同じ結果になる
  const h = createMatch(sampleInput(5, { rules: { half: 3, et: 0, pk: false, ko: false }, changes: [{ t: 2400, k: 0, type: 'tac', tactics: { press: 1, tempo: 1, line: 1 } }, { t: 4800, k: 1, type: 'tac', tactics: { build: -1, risk: -1 } }] }));
  run2(h, END);
  assert.equal(digestMatch(h), D, '入力に書いた指示変更と setTactics は同じ');
});

await test('goals: 得点者とアシストの記録（触れた順・間に相手が触れたら切れる・10秒まで・はじかれて入ったら撃った選手・オウンゴール）', () => {
  const mkm = () => { const team = new Uint8Array(22); for (let i = 11; i < 22; i++) team[i] = 1; const N = new Int32Array(N_LEN); for (let k = 0; k < 2; k++) { N[I.T1 + k] = -1; N[I.T2 + k] = -1; N[I.T1T + k] = -1000000; N[I.T2T + k] = -1000000; } N[I.LAST] = -1; return { N, team }; };
  let m = mkm(); markTouch(m, 3, 100); markTouch(m, 5, 120);
  assert.deepEqual(goalCredit(m, 0, 140), [5, 3, 0], '3→5→ゴール: 得点者5・アシスト3');
  m = mkm(); markTouch(m, 3, 100); markTouch(m, 15, 110); markTouch(m, 5, 120);
  assert.deepEqual(goalCredit(m, 0, 140), [5, -1, 0], '間に相手が触れたら、アシストなし');
  m = mkm(); markTouch(m, 3, 100); markTouch(m, 5, 400);
  assert.deepEqual(goalCredit(m, 0, 410), [5, -1, 0], '10秒より前の接触はアシストにしない');
  m = mkm(); markTouch(m, 3, 100); markTouch(m, 5, 120); markTouch(m, 11, 125); // 撃った → GK（相手）がはじいて入った
  assert.deepEqual(goalCredit(m, 0, 140), [5, 3, 0], 'はじかれて入った得点は、撃った選手（GKの得点にしない）');
  m = mkm(); markTouch(m, 5, 120); markTouch(m, 14, 500);
  assert.deepEqual(goalCredit(m, 0, 510), [14, -1, 1], '直前に守る側が触れ、攻める側の接触が3秒より前なら、オウンゴール');
  m = mkm(); markTouch(m, 5, 100); markTouch(m, 5, 120); markTouch(m, 15, 130); markTouch(m, 5, 140);
  assert.deepEqual(goalCredit(m, 0, 150), [5, -1, 0], '同じ選手が続けて触れても、間に相手が触れていればアシストなし');
  // 実際の試合の記録: 得点者は得点側の選手（オウンゴールを除く）、アシストは同じチームの別の選手
  let goals = 0, assists = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const mm = mk(seed, { rules: { half: 15, et: 0, pk: false, ko: false } }); run(mm);
    for (const e of mm.log) if (e[1] === EV.GOAL) {
      const [, , k, sc, as, og] = e; goals++;
      assert.equal(e.length, 6);
      if (!og) assert.equal(Math.floor(sc / 11), k, '得点者は得点したチームの選手');
      if (as >= 0) { assists++; assert.equal(Math.floor(as / 11), k, 'アシストは同じチーム'); assert.notEqual(as, sc); }
    }
  }
  return `8試合×30分: ゴール ${goals}・アシストあり ${assists}`;
});

await test('digest: チェック値は全ビット（小さな差も見える。-0 と 0・NaN は同じ扱い）', () => {
  const h = (v) => new Digest().num(v).hex();
  assert.notEqual(h(1), h(1 + 1e-12), '1e-12 の差も別の値になる（v13は 1/1024 に丸めていた）');
  assert.notEqual(h(0.5), h(0.5 + Number.EPSILON));
  assert.equal(h(-0), h(0));
  assert.equal(h(NaN), h(NaN));
  assert.notEqual(h(1), h(2));
  assert.equal(new Digest().nums([1.5, -2.25]).hex(), new Digest().num(1.5).num(-2.25).hex());
});

await test('selfcheck: 実機の自己診断の基準（data/selfcheck.js）と一致', () => {
  const r = selfCheck();
  assert.ok(r.ok, `自己診断が基準と違う（${r.got} / ${r.expected}、エンジン版 ${r.engine} / ${r.expectedEngine}）。エンジンを意図して変えたなら npm run golden`);
  return r.got;
});


// ── 基準値（端末間の一致確認と同じもの）──
await test('golden: 基準値（tools/golden.json）と一致', async () => {
  const gold = JSON.parse(readFileSync(new URL('./golden.json', import.meta.url), 'utf8'));
  assert.deepEqual(await computeGolden(), gold, 'エンジンを意図して変えたなら npm run golden で基準値を更新し、ENGINE_VERSION も上げる');
});

await test('速度の目安（1試合を最後まで）', () => {
  const m = mk(1), t0 = performance.now();
  run(m);
  const s = (performance.now() - t0) / 1000;
  return `${s.toFixed(2)} 秒（${Math.round(FULL_TICKS / s / 1000)}k tick/秒）`;
});

console.log(fails ? `\n${fails} 件失敗` : '\n全部通った');
process.exit(fails ? 1 : 0);
