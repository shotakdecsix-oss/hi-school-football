// 能力の効きを「ランダムな割り当て＋回帰」で測る（エンジンレビュー #5）。
//   node tools/sens.js [--n 480] [--seed 1] [--d 3] [--rules league] [--out 記録.jsonl] [--tacH key=v,…] [--tacA …]
// 1試合ごとに、能力のグループ（下の GROUPS）それぞれに、両チームとも -d〜+d の整数をランダムに足して走らせる（同じ値を外野手・控え全員に）。
// 得点差（チーム0−チーム1）を、グループごとの差（チーム0の足した値−チーム1の足した値）で回帰する。割り当てがランダム・互いに無相関なので、
// 1回の計測で全グループの効きが同時に出る（片側だけ上げる実験を能力の数だけ回さなくてよい）。傾き β = 能力+1（そのグループ全員）あたりの得点差/試合。
//   SE ≒ 0.57/√N（d=3 のとき）。N=480 で ±0.026、N=1000 で ±0.018。
//   読み方: 効きが 0 に近い能力＝育成しても試合に出ない（死んでいる）／突出している能力＝他を食う。「全部+1」の和は能力が一律に+1 違うチームどうしの差に近い。
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { AB } from '../engine/abil.js';

export const GROUPS = [
  { key: 'speed', name: '速さ（SPD・ACC）', idx: [AB.SPD, AB.ACC] },
  { key: 'agi', name: '敏捷（AGI）', idx: [AB.AGI] },
  { key: 'stamina', name: 'スタミナ（STM・WRK）', idx: [AB.STM, AB.WRK] },
  { key: 'tackle', name: '奪う（TCK・AGG）', idx: [AB.TCK, AB.AGG] },
  { key: 'read', name: '守備の読み（MRK・POS・ANT・CON）', idx: [AB.MRK, AB.POS, AB.ANT, AB.CON] },
  { key: 'carry', name: '運ぶ・競る（DRI・BAL・STR）', idx: [AB.DRI, AB.BAL, AB.STR] },
  { key: 'touch', name: '止める（TRP・CMP）', idx: [AB.TRP, AB.CMP] },
  { key: 'pass', name: '蹴る（PAS・LNG）', idx: [AB.PAS, AB.LNG] },
  { key: 'vision', name: '判断・視野（DEC・VIS）', idx: [AB.DEC, AB.VIS] },
  { key: 'shoot', name: '決める（SHT）', idx: [AB.SHT] },
  { key: 'off', name: '動き出し（OFF）', idx: [AB.OFF] },
  { key: 'air', name: '空中（HED・JMP）', idx: [AB.HED, AB.JMP] },
  { key: 'set', name: 'クロス・セット（CRS・SET）', idx: [AB.CRS, AB.SET] },
  { key: 'ldr', name: '統率（LDR）', idx: [AB.LDR] },
  { key: 'gk', name: 'GK（GKR・GKC・GK1・GKH・GKD）', idx: [AB.GKR, AB.GKC, AB.GK1, AB.GKH, AB.GKD] },
];
const G = GROUPS.length;

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const parseTac = (txt) => Object.fromEntries(String(txt || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, +v]; }));

// 最小二乗（正規方程式をガウスの消去法で解く）。X: 行ごとの説明変数（先頭に切片 1 を足す）、y: 目的変数。返り値 { b, se, r2 }
export function ols(X, y) {
  const n = y.length, p = X[0].length + 1;
  const A = Array.from({ length: p }, () => new Float64Array(2 * p)); // [XtX | I]
  const row = (r) => [1, ...X[r]];
  const xty = new Float64Array(p);
  for (let r = 0; r < n; r++) {
    const x = row(r);
    for (let i = 0; i < p; i++) { xty[i] += x[i] * y[r]; for (let j = 0; j < p; j++) A[i][j] += x[i] * x[j]; }
  }
  for (let i = 0; i < p; i++) A[i][p + i] = 1;
  for (let c = 0; c < p; c++) {
    let m = c;
    for (let r = c + 1; r < p; r++) if (Math.abs(A[r][c]) > Math.abs(A[m][c])) m = r;
    [A[c], A[m]] = [A[m], A[c]];
    const d = A[c][c];
    for (let j = 0; j < 2 * p; j++) A[c][j] /= d;
    for (let r = 0; r < p; r++) if (r !== c) { const f = A[r][c]; if (f !== 0) for (let j = 0; j < 2 * p; j++) A[r][j] -= f * A[c][j]; }
  }
  const b = new Float64Array(p);
  for (let i = 0; i < p; i++) for (let j = 0; j < p; j++) b[i] += A[i][p + j] * xty[j];
  let sse = 0, sst = 0; const my = y.reduce((a, v) => a + v, 0) / n;
  for (let r = 0; r < n; r++) { const x = row(r); let f = 0; for (let i = 0; i < p; i++) f += b[i] * x[i]; sse += (y[r] - f) ** 2; sst += (y[r] - my) ** 2; }
  const s2 = sse / (n - p);
  return { b, se: Array.from({ length: p }, (_, i) => Math.sqrt(s2 * A[i][p + i])), r2: 1 - sse / sst, sd: Math.sqrt(s2) };
}

if (isMainThread) {
  const N = +arg('n', 480), s0 = +arg('seed', 1), D = +arg('d', 3), rkey = arg('rules', 'league'), out = arg('out', '');
  const tacH = arg('tacH', ''), tacA = arg('tacA', '');
  const { RULES } = await import('../data/rules.js');
  if (!RULES[rkey]) { console.log('--rules は ' + Object.keys(RULES).join(' / ') + ' から選ぶ'); process.exit(2); }
  const jobs = Array.from({ length: N }, (_, i) => ({ seed: s0 + i, D, rkey, tacH: parseTac(tacH), tacA: parseTac(tacA) }));
  const rows = []; let next = 0; const t0 = Date.now();
  if (out) fs.writeFileSync(out, '');
  await new Promise((resolve) => {
    const NW = 2; let alive = NW;
    for (let w = 0; w < NW; w++) {
      const wk = new Worker(new URL(import.meta.url));
      const give = () => { if (next < jobs.length) wk.postMessage(jobs[next++]); else { wk.terminate(); if (--alive === 0) resolve(); } };
      wk.on('message', (r) => { rows.push(r); if (out) fs.appendFileSync(out, JSON.stringify(r) + '\n'); if (rows.length % 50 === 0) console.error(rows.length + '/' + N + ' ' + ((Date.now() - t0) / 1000).toFixed(0) + 's'); give(); });
      give();
    }
  });
  rows.sort((a, b) => a.seed - b.seed);
  const X = rows.map((r) => r.o0.map((v, g) => v - r.o1[g])), y = rows.map((r) => r.g0 - r.g1);
  const f = ols(X, y);
  const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  console.log('能力の効き（回帰）  ' + N + '試合（種 ' + s0 + '〜' + (s0 + N - 1) + '）  規定 ' + rkey + '  足す値 ±' + D + '  1試合の得点 ' + mean('g0').toFixed(2) + ' - ' + mean('g1').toFixed(2) + '  得点差の残りのばらつき ' + f.sd.toFixed(2) + '  R² ' + f.r2.toFixed(3));
  console.log('傾き β = そのグループが+1（全員）のときの得点差/試合。t = β/SE（2未満は0と区別できない）');
  let sum = 0;
  GROUPS.forEach((g, i) => {
    const b = f.b[i + 1], se = f.se[i + 1]; sum += b;
    console.log(g.name + '  ' + b.toFixed(3) + ' ±' + se.toFixed(3) + '  t=' + (b / se).toFixed(1) + '  ' + '#'.repeat(Math.max(0, Math.round(b * 40))));
  });
  console.log('切片 ' + f.b[0].toFixed(3) + ' ±' + f.se[0].toFixed(3) + '（0に近いほど、チーム0・1に偏りなし）   Σβ（全グループ+1） ' + sum.toFixed(3));
} else {
  const { createMatch, run } = await import('../engine/match.js');
  const { sampleInput } = await import('../engine/sample.js');
  const { RULES } = await import('../data/rules.js');
  const { hash4 } = await import('../engine/core/rng.js');
  const { EV } = await import('../engine/consts.js');
  parentPort.on('message', ({ seed, D, rkey, tacH, tacA }) => {
    const inp = sampleInput(seed, { rules: { ...RULES[rkey] }, homeTac: tacH, awayTac: tacA });
    const o = [0, 1].map((k) => GROUPS.map((_, g) => Math.floor((hash4(seed, 7000 + g, k, 3) / 4294967296) * (2 * D + 1)) - D));
    [0, 1].forEach((k) => {
      for (const p of [...inp.teams[k].players, ...inp.teams[k].bench]) GROUPS.forEach((gr, g) => { for (const a of gr.idx) p.ab[a] = Math.min(20, Math.max(1, p.ab[a] + o[k][g])); });
    });
    const m = createMatch(inp); run(m);
    const gl = [0, 0];
    for (const e of m.log) if (e[1] === EV.GOAL) gl[e[2]]++;
    parentPort.postMessage({ seed, o0: o[0], o1: o[1], g0: gl[0], g1: gl[1] });
  });
}
