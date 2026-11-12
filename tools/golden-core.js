// 「基準値」の計算。Node（tools/test.js, tools/golden.js）とブラウザ（tools/check.html）の両方から使う。
// 同じ入力の試合を最後まで計算し、途中と最後のチェック値を並べる。端末が違っても同じ値になるはず。
import { createMatch, run, digestMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { ENGINE_VERSION, FULL_TICKS } from '../engine/consts.js';

export const GOLDEN_SPEC = {
  seeds: [1, 2, 3],
  ticks: [1200, 12000, FULL_TICKS],
  opts: { home: '4-4-2', away: '4-3-3', abilHome: 11, abilAway: 9 },
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
    out.cases[seed] = row;
  }
  return out;
}
