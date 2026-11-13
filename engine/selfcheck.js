// 実機の自己診断。同じ入力の短い試合（前後半各2分・認知あり・交代と指示変更つき）を最後まで計算し、チェック値を基準（data/selfcheck.js）と比べる。
// 端末・ブラウザの違いで試合が変わると、保存した試合の再生が合わなくなる。起動時に1度走らせて、ずれていたら知らせる（約0.2秒・開発機）。
// 基準は npm run golden（tools/golden.js --write）が data/selfcheck.js に書く。エンジンを意図して変えたときだけ更新する。
import { createMatch, run, digestMatch } from './match.js';
import { sampleInput } from './sample.js';
import { ENGINE_VERSION } from './consts.js';
import { SELF_CHECK } from '../data/selfcheck.js';

const SELF_RULES = { half: 2, et: 0, pk: false, ko: false, subs: 5, subTimes: 3 };
const SELF_CHANGES = [
  { t: 600, k: 0, type: 'sub', slot: 9, bench: 2 },
  { t: 1500, k: 1, type: 'tac', tactics: { press: 1, tempo: 1, build: 1, line: -1 } },
];

// 自己診断の試合のチェック値（16桁の16進）
export function selfDigest() {
  const m = createMatch(sampleInput(7, { home: '4-4-2', away: '4-3-3', abilHome: 11, abilAway: 9, rules: SELF_RULES, changes: SELF_CHANGES }));
  run(m);
  return digestMatch(m);
}

// { ok, got, expected, engine, expectedEngine }。ok でなければ、この端末ではエンジンの結果が基準と違う
export function selfCheck() {
  const got = selfDigest();
  return { ok: SELF_CHECK.engine === ENGINE_VERSION && got === SELF_CHECK.digest, got, expected: SELF_CHECK.digest, engine: ENGINE_VERSION, expectedEngine: SELF_CHECK.engine };
}
