// 能力の対比: 片方のチームの選手全員（控え含む）に +差/2、もう片方に −差/2 を、指定した能力に足して回し、得点差・奪い返し・タッチ失敗・シュートなどの差を出す。
//   node tools/contrast.js N 能力名,能力名 差 [能力=倍率,…] [seed0]   例: node tools/contrast.js 32 AGI 12 AGI=1   （倍率 1 は圧縮なし）
//   効きを入れた直後の確認に使う（回帰より少ない試合で、シュート差などの動きの違いも見える）
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
if (isMainThread) {
  const N = +process.argv[2], names = process.argv[3].split(','), diff = +process.argv[4], gain = process.argv[5] || '', s0 = +(process.argv[6] || 1);
  const res = []; let next = 0, alive = 2;
  const ws = [0, 1].map(() => new Worker(new URL(import.meta.url), { workerData: { names, diff, gain } }));
  for (const w of ws) { const give = () => { if (next < N) w.postMessage(s0 + next++); else { w.terminate(); if (--alive === 0) done(); } }; w.on('message', (r) => { res.push(r); give(); }); give(); }
  function done() {
    const n = res.length, K = Object.keys(res[0]);
    const mean = (k) => res.reduce((a, r) => a + r[k], 0) / n, se = (k) => { const mu = mean(k); return Math.sqrt(res.reduce((a, r) => a + (r[k] - mu) ** 2, 0) / (n - 1) / n); };
    console.log(names.join('+') + ' home' + (diff / 2 >= 0 ? '+' : '') + diff / 2 + ' away' + (-diff / 2) + '  n=' + n + '  gain ' + gain);
    for (const k of K) console.log('  ' + k.padEnd(10), mean(k).toFixed(2), '±' + se(k).toFixed(2));
  }
} else {
  const { createMatch, run } = await import(new URL('../engine/match.js', import.meta.url).href);
  const { sampleInput } = await import(new URL('../engine/sample.js', import.meta.url).href);
  const { RULES } = await import(new URL('../data/rules.js', import.meta.url).href);
  const { AB, AB_GA } = await import(new URL('../engine/abil.js', import.meta.url).href);
  const { EV, I, ST, ST_N } = await import(new URL('../engine/consts.js', import.meta.url).href);
  const { names, diff, gain } = workerData;
  for (const kv of gain.split(',').filter(Boolean)) { const [k, v] = kv.split('='); AB_GA[AB[k]] = +v; }
  parentPort.on('message', (seed) => {
    const inp = sampleInput(seed, { rules: { ...RULES.league } });
    [0, 1].forEach((k) => { const d = k === 0 ? diff / 2 : -diff / 2; for (const p of [...inp.teams[k].players, ...inp.teams[k].bench]) for (const nme of names) p.ab[AB[nme]] = Math.min(20, Math.max(1, p.ab[AB[nme]] + d)); });
    const m = createMatch(inp); run(m);
    const gl = [0, 0]; for (const e of m.log) if (e[1] === EV.GOAL) gl[e[2]]++;
    const S = (k, x) => m.N[I.ST + k * ST_N + ST[x]];
    parentPort.postMessage({ gd: gl[0] - gl[1], 'icpt0-1': S(0, 'ICPT') - S(1, 'ICPT'), 'tkl0-1': S(0, 'TKL') - S(1, 'TKL'), 'passOk0': 100 * S(0, 'PASSOK') / Math.max(1, S(0, 'PASS')), 'passOk1': 100 * S(1, 'PASSOK') / Math.max(1, S(1, 'PASS')), 'pass0-1': S(0, 'PASS') - S(1, 'PASS'), 'miss0-1': S(0, 'MISC') - S(1, 'MISC'), 'shots0-1': m.N[I.SHOTS] - m.N[I.SHOTS + 1] });
  });
}
