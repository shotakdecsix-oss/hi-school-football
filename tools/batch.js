// 一括実行（同じ設定で種だけ変えて N 試合）。数値でAIの出来を確かめる道具。
//   node tools/batch.js [--n 20] [--seed 1] [--home 4-4-2] [--away 4-4-2] [--ha 10] [--aa 10] [--rules sensyuken] [--ko] [--flat] [--check]
// --rules: 試合規定（data/rules.js のキー。既定 sensyuken = 80分）。--ko: ノックアウト戦にする（同点なら延長・PK戦。既定はリーグ戦扱いで同点はそのまま）
// --flat : 全選手の全能力を同じ値にする（ha/aa）。サンプルの能力ばらつきを外して、エンジン自体の偏りを見る
// --check: 各試合を2回走らせてチェック値が一致するか確かめる（再現性の確認）
import { createMatch, stepMatch, run, digestMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { I, ST, ST_N, NP, HL, HW, PHASE, dirOf } from '../engine/consts.js';
import { RULES } from '../data/rules.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const n = +arg('n', 20), seed0 = +arg('seed', 1), check = process.argv.includes('--check'), flat = process.argv.includes('--flat');
const rkey = arg('rules', 'sensyuken'), ko = process.argv.includes('--ko');
if (!RULES[rkey]) { console.log('--rules は ' + Object.keys(RULES).join(' / ') + ' から選ぶ'); process.exit(2); }
const rules = { ...RULES[rkey], ko };
const o = { home: arg('home', '4-4-2'), away: arg('away', '4-4-2'), abilHome: +arg('ha', 10), abilAway: +arg('aa', 10), rules };
const SAMPLE_EVERY = 10; // 0.5 秒ごとに動きを測る

const mkInput = (seed) => {
  if (!flat) return sampleInput(seed, o);
  const team = (f, a) => ({ formation: f, players: Array.from({ length: 11 }, (_, s) => ({ id: 'x' + s, ab: a })) });
  return { seed, changes: [], rules, teams: [team(o.home, o.abilHome), team(o.away, o.abilAway)] };
};

const KEYS = ['goals', 'shots', 'sot', 'save', 'pass', 'ok', 'lob', 'clr', 'tkl', 'tklw', 'icpt', 'miss', 'drib'];
const tot = [0, 1].map(() => Object.fromEntries(KEYS.map((k) => [k, 0])));
const mv = [0, 1].map(() => ({ n: 0, far8: 0, far12: 0, disp: 0, near15: 0, near3: 0, len: 0, wid: 0, ticks: 0, poss: 0 }));
let w = 0, d = 0, l = 0, bad = 0, ticksLive = 0, ticksAll = 0, allTicks = 0;
const t0 = performance.now();

for (let s = 0; s < n; s++) {
  const input = mkInput(seed0 + s), m = createMatch(input);
  while (stepMatch(m)) {
    if (m.t % SAMPLE_EVERY) continue;
    ticksAll++;
    if (m.N[I.PHASE] !== PHASE.LIVE) continue;
    ticksLive++;
    const pk = m.N[I.POSS]; mv[pk].poss++;
    const own = m.N[I.OWN];
    for (let k = 0; k < 2; k++) {
      const dir = dirOf(m.N, k), M = mv[k], base = k * 11;
      const att = own >= 0 && m.team[own] === k; // 持っているチームだけ集計（守備側は別に len/wid だけ）
      let mn = 99, mx = -99, ymn = 99, ymx = -99;
      for (let s2 = 1; s2 < 11; s2++) {
        const i = base + s2, fx = m.px[i] * dir, fy = m.py[i] * dir;
        if (fx < mn) mn = fx; if (fx > mx) mx = fx; if (fy < ymn) ymn = fy; if (fy > ymx) ymx = fy;
        if (!att || i === own) continue;
        const sx = -HL + Math.min(m.fd[i], 0.95) * 2 * HL, sy = m.fl[i] * HW * 0.9;
        const dd = Math.sqrt((fx - sx) * (fx - sx) + (fy - sy) * (fy - sy));
        M.n++; M.disp += dd; if (dd > 8) M.far8++; if (dd > 12) M.far12++;
      }
      if (att) {
        const cx = m.px[own], cy = m.py[own], ds = [];
        for (let s2 = 1; s2 < 11; s2++) {
          const i = base + s2; if (i === own) continue;
          ds.push(Math.sqrt((m.px[i] - cx) * (m.px[i] - cx) + (m.py[i] - cy) * (m.py[i] - cy)));
        }
        ds.sort((a, b) => a - b);
        M.near15 += ds.filter((v) => v < 15).length; M.near3 += (ds[0] + ds[1] + ds[2]) / 3;
        M.len += mx - mn; M.wid += ymx - ymn; M.ticks++;
      }
    }
  }
  allTicks += m.t * (check ? 2 : 1);
  const a = m.N[I.SCORE], b = m.N[I.SCORE + 1];
  if (a > b) w++; else if (a === b) d++; else l++;
  for (let k = 0; k < 2; k++) {
    const B = I.ST + k * ST_N, t = tot[k];
    t.goals += m.N[I.SCORE + k]; t.shots += m.N[I.SHOTS + k];
    t.sot += m.N[B + ST.SOT]; t.save += m.N[B + ST.SAVE]; t.pass += m.N[B + ST.PASS]; t.ok += m.N[B + ST.PASSOK];
    t.lob += m.N[B + ST.LOB]; t.clr += m.N[B + ST.CLR]; t.tkl += m.N[B + ST.TKL]; t.tklw += m.N[B + ST.TKLW];
    t.icpt += m.N[B + ST.ICPT]; t.miss += m.N[B + ST.MISC]; t.drib += m.N[B + ST.DRIB];
  }
  if (check) {
    const m2 = createMatch(input);
    run(m2);
    if (digestMatch(m2) !== digestMatch(m)) { bad++; console.log('不一致 seed', seed0 + s); }
  }
}

const sec = (performance.now() - t0) / 1000, runs = n * (check ? 2 : 1);
const f1 = (x) => x.toFixed(1), pc = (x) => Math.round(100 * x) + '%';
console.log(`${o.home}(力${o.abilHome}) vs ${o.away}(力${o.abilAway})${flat ? ' 能力一律' : ''}  ${n}試合（種 ${seed0}〜${seed0 + n - 1}）  規定 ${rkey}${ko ? '(ノックアウト)' : ''}  勝${w} 分${d} 負${l}`);
console.log('1試合あたり    得点  シュ 枠内 セーブ  パス 成功率 浮球 クリア  タックル(勝)  奪取 ﾀｯﾁ失敗 ドリブル 保持率');
for (let k = 0; k < 2; k++) {
  const t = tot[k], p = (x) => f1(x / n).padStart(6);
  console.log(`  チーム${k}    ${p(t.goals)}${p(t.shots)}${p(t.sot)}${p(t.save)}${p(t.pass)}  ${pc(t.ok / Math.max(1, t.pass)).padStart(5)}${p(t.lob)}${p(t.clr)}   ${f1(t.tkl / n).padStart(5)}(${f1(t.tklw / n).padStart(4)})${p(t.icpt)}${p(t.miss)}${p(t.drib)}  ${pc(mv[k].poss / Math.max(1, mv[0].poss + mv[1].poss)).padStart(5)}`);
}
console.log('攻撃中の動き（保持側の外野手）  陣形から8m超/12m超の人数   平均ずれ   保持者から15m以内の味方   最寄り3人の平均距離   縦幅/横幅');
for (let k = 0; k < 2; k++) {
  const M = mv[k], per = M.n / Math.max(1, M.ticks);
  console.log(`  チーム${k}   ${f1(M.far8 / Math.max(1, M.ticks))}人 / ${f1(M.far12 / Math.max(1, M.ticks))}人 （外野9人中）   ${f1(M.disp / Math.max(1, M.n))}m   ${f1(M.near15 / Math.max(1, M.ticks))}人   ${f1(M.near3 / Math.max(1, M.ticks))}m   ${f1(M.len / Math.max(1, M.ticks))}m / ${f1(M.wid / Math.max(1, M.ticks))}m${per ? '' : ''}`);
}
console.log(`ボールが生きている時間 ${pc(ticksLive / Math.max(1, ticksAll))}（試合時間のうち、止まっている時間を除く）`);
console.log(`所要 ${sec.toFixed(1)} 秒（1試合 ${(sec / runs).toFixed(2)} 秒、${Math.round(allTicks / sec / 1000)}k tick/秒）${check ? `  再現性の不一致 ${bad} 件` : ''}`);
process.exit(bad ? 1 : 0);
