// 「基準値」の計算。Node（tools/test.js, tools/golden.js）とブラウザ（tools/check.html）の両方から使う。
// 同じ入力の試合を最後まで計算し、途中と最後のチェック値を並べる。端末が違っても同じ値になるはず。
import { createMatch, run, digestMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { ENGINE_VERSION } from '../engine/consts.js';
import { RULES } from '../data/rules.js';

// ticks の最後（Infinity）は「試合の最後まで」。cases は条件違いの組（リーグ戦90分と、延長・PK戦まで通る超短い試合、交代あり、認知なし）
export const GOLDEN_SPEC = {
  seeds: [1, 2, 3],
  ticks: [1200, 12000, Infinity],
  opts: { home: '4-4-2', away: '4-3-3', abilHome: 11, abilAway: 9 },
  short: { half: 2, et: 1, pk: true, ko: true, subs: 5, subTimes: 3 }, // 4分+延長2分（同点が多く、延長・PK戦まで通る）
  changes: [
    { t: 600, k: 0, type: 'sub', slot: 9, bench: 2 }, { t: 900, k: 1, type: 'sub', slot: 6, bench: 5 }, // 30秒・45秒のあとの最初の中断
    { t: 2400, k: 0, type: 'sub', slot: 0, bench: 0 }, { t: 2400, k: 1, type: 'sub', slot: 3, bench: 1 }, // ハーフタイム（2分）
    { t: 5000, k: 0, type: 'sub', slot: 10, bench: 7 }, // 延長前半（短縮規則では 2分+2分+1分）
  ],
};

export async function computeGolden(spec = GOLDEN_SPEC, onStep = async () => {}) {
  const out = { engine: ENGINE_VERSION, cases: {} };
  for (const seed of spec.seeds) {
    const m = createMatch(sampleInput(seed, spec.opts));
    const row = [];
    for (const T of spec.ticks) {
      run(m, T);
      row.push(digestMatch(m));
      await onStep(seed, T);
    }
    const ms = createMatch(sampleInput(seed, { ...spec.opts, rules: spec.short }));
    run(ms);
    row.push(digestMatch(ms));
    await onStep(seed, 0);
    const mc = createMatch(sampleInput(seed, { ...spec.opts, rules: spec.short, changes: spec.changes })); // 交代あり（ハーフタイム・中断・GK交代）
    run(mc);
    row.push(digestMatch(mc));
    await onStep(seed, 0);
    const mp = createMatch(sampleInput(seed, { ...spec.opts, percept: 0 })); // 認知なし（全員が全部見えている従来の動き。比較用に残してある）
    run(mp);
    row.push(digestMatch(mp));
    await onStep(seed, 0);
    out.cases[seed] = row;
  }
  return out;
}
