// 一括実行（同じ設定で種だけ変えて N 試合）。
//   node tools/batch.js [--n 100] [--seed 1] [--home 4-4-2] [--away 4-4-2] [--ha 10] [--aa 10] [--check]
// --check: 各試合を2回走らせてチェック値が一致するか確かめる（再現性の確認）
import { createMatch, run, digestMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { FULL_TICKS, I } from '../engine/consts.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const n = +arg('n', 100), seed0 = +arg('seed', 1), check = process.argv.includes('--check');
const o = { home: arg('home', '4-4-2'), away: arg('away', '4-4-2'), abilHome: +arg('ha', 10), abilAway: +arg('aa', 10) };

let w = 0, d = 0, l = 0, g0 = 0, g1 = 0, s0 = 0, s1 = 0, bad = 0;
const t0 = performance.now();
for (let s = 0; s < n; s++) {
  const input = sampleInput(seed0 + s, o), m = createMatch(input);
  run(m);
  const a = m.N[I.SCORE], b = m.N[I.SCORE + 1];
  g0 += a; g1 += b; s0 += m.N[I.SHOTS]; s1 += m.N[I.SHOTS + 1];
  if (a > b) w++; else if (a === b) d++; else l++;
  if (check) {
    const m2 = createMatch(input);
    run(m2);
    if (digestMatch(m2) !== digestMatch(m)) { bad++; console.log('不一致 seed', seed0 + s); }
  }
}
const sec = (performance.now() - t0) / 1000, runs = n * (check ? 2 : 1);
console.log(`${o.home}(力${o.abilHome}) vs ${o.away}(力${o.abilAway})  ${n}試合（種 ${seed0}〜${seed0 + n - 1}）`);
console.log(`勝 ${w} / 分 ${d} / 負 ${l}   得点 平均 ${(g0 / n).toFixed(2)} - ${(g1 / n).toFixed(2)}   シュート 平均 ${(s0 / n).toFixed(1)} - ${(s1 / n).toFixed(1)}`);
console.log(`所要 ${sec.toFixed(1)} 秒（1試合 ${(sec / runs).toFixed(2)} 秒、${Math.round((runs * FULL_TICKS) / sec / 1000)}k tick/秒）${check ? `  再現性の不一致 ${bad} 件` : ''}`);
console.log('※ 仮AIの数値。サッカーとしての意味はない（段階2で判断AIに置き換える）');
process.exit(bad ? 1 : 0);
