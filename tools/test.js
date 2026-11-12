// 自動テスト。node tools/test.js（または npm test）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from '../engine/core/math.js';
import { hash4, f4, normal4, Stream } from '../engine/core/rng.js';
import { createMatch, stepMatch, run, snapshot, restore, snapshotToJSON, digestMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { stepBall } from '../engine/ball.js';
import { FULL_TICKS, HALF_TICKS, HL, HW, NP, I, PHASE, EV, F_B, F_R, PA_D, PA_HW, SP } from '../engine/consts.js';
import { RULES, normRules } from '../data/rules.js';
import { computeGolden } from './golden-core.js';

let fails = 0;
const test = async (name, fn) => {
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

// ── 決まりごとの検査 ──
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : []; });
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
