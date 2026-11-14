// 全体の効きの大きさの確認: 能力が一律に差 d のチームどうし（home=10+d・away=10、全能力同じ値、4-4-2、league）を回して、勝ち点率と得点比の対数を出す。
//   node tools/calib.js N d [C] [seed0]    C=能力の効き倍率（AB_GA）を全体にかける（既定 1）。目標: 得点比の対数 d=1・3・5 で 0.30・1.30・1.90
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
if (isMainThread) {
  const N = +process.argv[2], d = +process.argv[3], C = +(process.argv[4] || 1), s0 = +(process.argv[5] || 7000);
  const res = []; let next = 0, alive = 2;
  const ws = [0, 1].map(() => new Worker(new URL(import.meta.url), { workerData: { d, C } }));
  for (const w of ws) { const give = () => { if (next < N) w.postMessage(s0 + next++); else { w.terminate(); if (--alive === 0) done(); } }; w.on('message', (r) => { res.push(r); give(); }); give(); }
  function done() {
    const gf = res.reduce((a, r) => a + r[0], 0), ga = res.reduce((a, r) => a + r[1], 0), n = res.length;
    const W = res.filter((r) => r[0] > r[1]).length, D = res.filter((r) => r[0] === r[1]).length, L = n - W - D;
    console.log('d=' + d + ' C=' + C + ' n=' + n + '  勝' + W + ' 分' + D + ' 負' + L + '  勝ち点率 ' + (100 * (3 * W + D) / (3 * n)).toFixed(1) + '%  得点 ' + (gf / n).toFixed(2) + '-' + (ga / n).toFixed(2) + '  ln(得点比) ' + Math.log(gf / Math.max(1, ga)).toFixed(2) + ' ±' + Math.sqrt(1 / gf + 1 / Math.max(1, ga)).toFixed(2));
  }
} else {
  const { createMatch, run } = await import(new URL('../engine/match.js', import.meta.url).href);
  const { sampleInput } = await import(new URL('../engine/sample.js', import.meta.url).href);
  const { RULES } = await import(new URL('../data/rules.js', import.meta.url).href);
  const { AB_GA } = await import(new URL('../engine/abil.js', import.meta.url).href);
  const { EV } = await import(new URL('../engine/consts.js', import.meta.url).href);
  const { d, C } = workerData;
  for (let k = 0; k < AB_GA.length; k++) AB_GA[k] *= C;
  parentPort.on('message', (seed) => {
    const inp = sampleInput(seed, { home: '4-4-2', away: '4-4-2', abilHome: 10 + d, abilAway: 10, rules: { ...RULES.league } });
    [0, 1].forEach((k) => { for (const p of [...inp.teams[k].players, ...inp.teams[k].bench]) p.ab = Array.from({ length: 32 }, () => (k === 0 ? 10 + d : 10)); }); // 全能力を同じ値に（batch.js の --flat）
    const m = createMatch(inp); run(m);
    const gl = [0, 0]; for (const e of m.log) if (e[1] === EV.GOAL) gl[e[2]]++;
    parentPort.postMessage(gl);
  });
}
