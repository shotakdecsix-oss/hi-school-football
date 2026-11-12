// 「基準値」の計算。Node（tools/test.js, tools/golden.js）とブラウザ（tools/check.html）の両方から使う。
// 同じ入力の試合を最後まで計算し、途中と最後のチェック値を並べる。端末が違っても同じ値になるはず。
import { createMatch, run, digestMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { ENGINE_VERSION } from '../engine/consts.js';
import { RULES } from '../data/rules.js';

// ticks の最後（Infinity）は「試合の最後まで」。cases は条件違いの組（リーグ戦90分と、延長・PK戦まで通る超短い試合）
export const GOLDEN_SPEC = {
  seeds: [1, 2, 3],
  ticks: [1200, 12000, Infinity],
  opts: { home: '4-4-2', away: '4-3-3', abilHome: 11, abilAway: 9 },
  short: { half: 2, et: 1, pk: true, ko: true, subs: 5, subTimes: 3 }, // 4分+延長2分（同点が多く、延長・PK戦まで通る）
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
    out.cases[seed] = row;
  }
  return out;
}
