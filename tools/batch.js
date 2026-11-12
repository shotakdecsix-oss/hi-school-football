// 一括実行（同じ設定で種だけ変えて N 試合）。数値でAIの出来を確かめる道具。
//   node tools/batch.js [--n 20] [--seed 1] [--home 4-4-2] [--away 4-4-2] [--ha 10] [--aa 10] [--rules sensyuken] [--ko] [--flat] [--check] [--tacH line=1,compact=1] [--tacA ...]
// --rules: 試合規定（data/rules.js のキー。既定 sensyuken = 80分）。--ko: ノックアウト戦にする（同点なら延長・PK戦。既定はリーグ戦扱いで同点はそのまま）
// --flat : 全選手の全能力を同じ値にする（ha/aa）。サンプルの能力ばらつきを外して、エンジン自体の偏りを見る
// --check: 各試合を2回走らせてチェック値が一致するか確かめる（再現性の確認）
// --tacH / --tacA: 家（チーム0）・相手（チーム1）のチーム指示（data/tactics.js のキー=-1〜1 をカンマ区切り。例 line=1,pressPower=0.5）。
//   指示を与えるか --def を付けると、守備のブロック（相手が保持しているときの陣形）の表も出す
import { createMatch, stepMatch, run, digestMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { I, ST, ST_N, NP, HL, HW, PHASE, EV, ACT, F_B, F_STA, dirOf } from '../engine/consts.js';
import { RULES } from '../data/rules.js';
import { TACTICS } from '../data/tactics.js';
import { staminaOf } from '../engine/stamina.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const n = +arg('n', 20), seed0 = +arg('seed', 1), check = process.argv.includes('--check'), flat = process.argv.includes('--flat');
const rkey = arg('rules', 'sensyuken'), ko = process.argv.includes('--ko');
if (!RULES[rkey]) { console.log('--rules は ' + Object.keys(RULES).join(' / ') + ' から選ぶ'); process.exit(2); }
const rules = { ...RULES[rkey], ko };
const parseTac = (txt) => {
  const t = {};
  for (const kv of String(txt || '').split(',').filter(Boolean)) {
    const [key, v] = kv.split('=');
    if (!TACTICS.some((d) => d.key === key) || !Number.isFinite(+v)) { console.log('--tacH/--tacA は ' + TACTICS.map((d) => d.key).join(' / ') + ' を key=値(-1〜1) で、カンマ区切りで渡す'); process.exit(2); }
    t[key] = +v;
  }
  return t;
};
const tacH = parseTac(arg('tacH', '')), tacA = parseTac(arg('tacA', ''));
const showDef = process.argv.includes('--def') || Object.keys(tacH).length + Object.keys(tacA).length > 0;
const o = { home: arg('home', '4-4-2'), away: arg('away', '4-4-2'), abilHome: +arg('ha', 10), abilAway: +arg('aa', 10), rules, homeTac: tacH, awayTac: tacA };
const SAMPLE_EVERY = 10; // 0.5 秒ごとに動きを測る

const mkInput = (seed) => {
  if (!flat) return sampleInput(seed, o);
  const team = (f, a, tactics) => ({ formation: f, tactics, players: Array.from({ length: 11 }, (_, s) => ({ id: 'x' + s, ab: a })) });
  return { seed, changes: [], rules, teams: [team(o.home, o.abilHome, tacH), team(o.away, o.abilAway, tacA)] };
};

const KEYS = ['goals', 'shots', 'sot', 'save', 'pass', 'ok', 'lob', 'clr', 'tkl', 'tklw', 'icpt', 'miss', 'drib', 'thr', 'gk', 'ck'];
const tot = [0, 1].map(() => Object.fromEntries(KEYS.map((k) => [k, 0])));
const mv = [0, 1].map(() => ({ n: 0, far8: 0, far12: 0, disp: 0, near15: 0, near3: 0, len: 0, wid: 0, ticks: 0, poss: 0 }));
const DZ = [0, 1].map(() => Array.from({ length: 3 }, () => ({ n: 0, line: 0, len: 0, wid: 0, press: 0, cover: 0, mark: 0, near: 0 }))); // 守備中の陣形（ボール位置の3区分ごと）
// 切り替え: 失った側(lost 等。ボールを失った位置の3区分 自陣/中盤/敵陣 ごと)と、奪った側(won 等)の集計
const SH = [0, 1].map(() => [0, 0]); // 前半・後半ごとのシュート数
const STA = [0, 1].map(() => ({ h1: 0, end: 0, min: 1 })); // スタミナ: 前半の終わり・試合の終わりの平均（外野手）と、最低の選手
const TR = [0, 1].map(() => ({ lost: [0, 0, 0], reg5: [0, 0, 0], shots8: [0, 0, 0], goals8: [0, 0, 0], won: 0, wshots8: 0, prog4: 0, progN: 0, behind: 0, behindN: 0, oh: 0, ohN: 0, r3b: 0, r3n: 0, r3c: 0 }));
let w = 0, d = 0, l = 0, bad = 0, ticksLive = 0, ticksAll = 0, allTicks = 0, pkMatches = 0;
const pkRes = [0, 0, 0]; // PK戦の1本ごとの結果（外れ・ゴール・セーブ）
const t0 = performance.now();

for (let s = 0; s < n; s++) {
  const input = mkInput(seed0 + s), m = createMatch(input);
  let lastC = -1e9;
  const chg = [], pend = [], pend3 = []; // 切り替え（ボールを持つチームが入れ替わった）の記録と、4秒後のボールの位置を見る予約
  while (stepMatch(m)) {
    if (m.t === m.pEnd[0] - 1) for (let k = 0; k < 2; k++) STA[k].h1 += staminaOf(m, k);
    const cc = m.N[I.CHGT];
    if (cc !== lastC) {
      lastC = cc;
      if (cc >= 0) { const w2 = m.N[I.POSS], fxl = m.F[F_B] * dirOf(m.N, 1 - w2); chg.push([cc, w2, fxl < -17.5 ? 0 : fxl < 17.5 ? 1 : 2]); pend.push([cc + 80, w2, m.F[F_B] * dirOf(m.N, w2)]); pend3.push([cc + 60, 1 - w2]); }
    }
    while (pend3.length && pend3[0][0] <= m.t) { // 失って3秒後: ボールより自陣側にいる人数と、ボールの 8m 以内にいる人数（失った側の外野手）
      const [, lo] = pend3.shift(), dl = dirOf(m.N, lo), bxl = m.F[F_B] * dl;
      let bb = 0, nb = 0;
      for (let s2 = 1; s2 < 11; s2++) { const i = lo * 11 + s2; if (m.px[i] * dl < bxl) bb++; if ((m.px[i] - m.F[F_B]) ** 2 + (m.py[i] - m.F[F_B + 1]) ** 2 < 64) nb++; }
      TR[lo].r3b += bb; TR[lo].r3c += nb; TR[lo].r3n++;
    }
    while (pend.length && pend[0][0] <= m.t) { const [, w2, fx0] = pend.shift(); TR[w2].prog4 += m.F[F_B] * dirOf(m.N, w2) - fx0; TR[w2].progN++; }
    if (m.t % SAMPLE_EVERY || m.N[I.PHASE] === PHASE.PK) continue;
    ticksAll++;
    if (m.N[I.PHASE] !== PHASE.LIVE) continue;
    ticksLive++;
    const pk = m.N[I.POSS]; mv[pk].poss++;
    const own = m.N[I.OWN];
    for (let k = 0; k < 2; k++) {
      const dir = dirOf(m.N, k), M = mv[k], base = k * 11;
      const att = own >= 0 && m.team[own] === k; // 持っているチームだけ集計（守備側は別に len/wid だけ）
      if (own >= 0 && !att) { // 守備中（相手が保持）: 自分の向きを+とした座標で、陣形と寄せの様子をボール位置の3区分ごとに集める
        const bfx = m.F[F_B] * dir, Z = DZ[k][bfx < -17.5 ? 0 : bfx < 17.5 ? 1 : 2], fxs = [];
        let ymn2 = 99, ymx2 = -99, pr = 0, cv = 0, mk = 0, nr = 99;
        for (let s2 = 1; s2 < 11; s2++) {
          const i = base + s2, a = m.act[i];
          fxs.push(m.px[i] * dir);
          if (m.py[i] * dir < ymn2) ymn2 = m.py[i] * dir; if (m.py[i] * dir > ymx2) ymx2 = m.py[i] * dir;
          if (a === ACT.PRESS) pr++; else if (a === ACT.COVER) cv++; else if (a === ACT.MARK) mk++;
          const dd = Math.sqrt((m.px[i] - m.F[F_B]) ** 2 + (m.py[i] - m.F[F_B + 1]) ** 2); if (dd < nr) nr = dd;
        }
        fxs.sort((a, b) => a - b);
        Z.n++; Z.line += (fxs[0] + fxs[1] + fxs[2] + fxs[3]) / 4; Z.len += fxs[9] - fxs[0]; Z.wid += ymx2 - ymn2; Z.press += pr; Z.cover += cv; Z.mark += mk; Z.near += nr;
      }
      let mn = 99, mx = -99, ymn = 99, ymx = -99, bh = 0, oh = 0;
      const bfx2 = m.F[F_B] * dir;
      for (let s2 = 1; s2 < 11; s2++) {
        const i = base + s2, fx = m.px[i] * dir, fy = m.py[i] * dir;
        if (att && bfx2 > 0 && i !== own && fx < bfx2 - 5) bh++; // 攻撃中（ボールが敵陣）に、ボールより 5m 以上後ろにいる外野手
        if (att && bfx2 > 15 && fx < 0) oh++; // 攻撃中（ボールが敵陣の奥）に、自陣側に残っている外野手
        if (fx < mn) mn = fx; if (fx > mx) mx = fx; if (fy < ymn) ymn = fy; if (fy > ymx) ymx = fy;
        if (!att || i === own) continue;
        const sx = -HL + Math.min(m.fd[i], 0.95) * 2 * HL, sy = m.fl[i] * HW * 0.9;
        const dd = Math.sqrt((fx - sx) * (fx - sx) + (fy - sy) * (fy - sy));
        M.n++; M.disp += dd; if (dd > 8) M.far8++; if (dd > 12) M.far12++;
      }
      if (att && bfx2 > 0) { TR[k].behind += bh; TR[k].behindN++; }
      if (att && bfx2 > 15) { TR[k].oh += oh; TR[k].ohN++; }
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
  const shotsE = m.log.filter((e) => e[1] === EV.SHOT), goalsE = m.log.filter((e) => e[1] === EV.GOAL);
  for (const e of shotsE) SH[e[2]][e[0] < m.pEnd[0] ? 0 : 1]++;
  for (let u = 0; u < chg.length; u++) {
    const [c, w2, z] = chg[u], lo = 1 - w2;
    TR[lo].lost[z]++; TR[w2].won++;
    if (u + 1 < chg.length && chg[u + 1][1] === lo && chg[u + 1][0] - c <= 100) TR[lo].reg5[z]++; // 5秒以内に奪い返した
    const sh = shotsE.filter((e) => e[0] > c && e[0] <= c + 160 && e[2] === w2).length; // 奪った側が8秒以内に撃ったシュート
    TR[lo].shots8[z] += sh; TR[w2].wshots8 += sh;
    TR[lo].goals8[z] += goalsE.filter((e) => e[0] > c && e[0] <= c + 160 && e[2] === w2).length;
  }
  for (let k = 0; k < 2; k++) { STA[k].end += staminaOf(m, k); for (let s2 = 1; s2 < 11; s2++) STA[k].min = Math.min(STA[k].min, m.F[F_STA + k * 11 + s2]); }
  allTicks += m.t * (check ? 2 : 1);
  const a = m.N[I.SCORE], b = m.N[I.SCORE + 1];
  if (a > b) w++; else if (a === b) d++; else l++;
  if (m.N[I.HALF] === 5) { pkMatches++; for (const e of m.log) if (e[1] === EV.PKK) pkRes[e[4]]++; }
  for (let k = 0; k < 2; k++) {
    const B = I.ST + k * ST_N, t = tot[k];
    t.goals += m.N[I.SCORE + k]; t.shots += m.N[I.SHOTS + k];
    t.sot += m.N[B + ST.SOT]; t.save += m.N[B + ST.SAVE]; t.pass += m.N[B + ST.PASS]; t.ok += m.N[B + ST.PASSOK];
    t.lob += m.N[B + ST.LOB]; t.clr += m.N[B + ST.CLR]; t.tkl += m.N[B + ST.TKL]; t.tklw += m.N[B + ST.TKLW];
    t.icpt += m.N[B + ST.ICPT]; t.miss += m.N[B + ST.MISC]; t.drib += m.N[B + ST.DRIB];
    t.thr += m.N[B + ST.THROW]; t.gk += m.N[B + ST.GKICK]; t.ck += m.N[B + ST.CORNER];
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
console.log('1試合あたり    得点  シュ 枠内 セーブ  パス 成功率 浮球 クリア  タックル(勝)  奪取 ﾀｯﾁ失敗 ドリブル 保持率 スロー  GK   CK');
for (let k = 0; k < 2; k++) {
  const t = tot[k], p = (x) => f1(x / n).padStart(6);
  console.log(`  チーム${k}    ${p(t.goals)}${p(t.shots)}${p(t.sot)}${p(t.save)}${p(t.pass)}  ${pc(t.ok / Math.max(1, t.pass)).padStart(5)}${p(t.lob)}${p(t.clr)}   ${f1(t.tkl / n).padStart(5)}(${f1(t.tklw / n).padStart(4)})${p(t.icpt)}${p(t.miss)}${p(t.drib)}  ${pc(mv[k].poss / Math.max(1, mv[0].poss + mv[1].poss)).padStart(5)}${p(t.thr)}${p(t.gk)}${p(t.ck)}`);
}
console.log('攻撃中の動き（保持側の外野手）  陣形から8m超/12m超の人数   平均ずれ   保持者から15m以内の味方   最寄り3人の平均距離   縦幅/横幅');
for (let k = 0; k < 2; k++) {
  const M = mv[k], per = M.n / Math.max(1, M.ticks);
  console.log(`  チーム${k}   ${f1(M.far8 / Math.max(1, M.ticks))}人 / ${f1(M.far12 / Math.max(1, M.ticks))}人 （外野9人中）   ${f1(M.disp / Math.max(1, M.n))}m   ${f1(M.near15 / Math.max(1, M.ticks))}人   ${f1(M.near3 / Math.max(1, M.ticks))}m   ${f1(M.len / Math.max(1, M.ticks))}m / ${f1(M.wid / Math.max(1, M.ticks))}m${per ? '' : ''}`);
}
if (showDef) {
  console.log('守備のブロック（相手が保持中。自陣ゴール=-52.5、攻める向き+）  ボール位置:  自陣(〜-17)  |  中盤  |  敵陣(17〜)      各: 時間割合 最終ライン(深い4人の平均) 縦幅 横幅 寄せ/カバー/マーク人数 ボールに最も近い守備者');
  for (let k = 0; k < 2; k++) {
    const tt = DZ[k].reduce((s, z) => s + z.n, 0);
    console.log(`  チーム${k}   ` + DZ[k].map((z) => (z.n ? `${pc(z.n / Math.max(1, tt)).padStart(4)} L${f1(z.line / z.n).padStart(6)} 縦${f1(z.len / z.n).padStart(5)} 横${f1(z.wid / z.n).padStart(5)} P${f1(z.press / z.n)}/C${f1(z.cover / z.n)}/M${f1(z.mark / z.n)} 近${f1(z.near / z.n).padStart(4)}m` : '-')).join('  |  '));
  }
}
{
  const sum = (a) => a[0] + a[1] + a[2];
  console.log('切り替え  失った回数(自陣/中盤/敵陣で)  5秒以内に奪い返した割合(敵陣で失った分)  失ってから8秒以内の被シュート/被ゴール(100回あたり)  奪った回数  奪って8秒以内の自分のシュート(100回あたり)  奪って4秒後のボール前進  攻撃中に後ろへ残る人数(ボール5m後ろ以上 / 敵陣奥で自陣側)  失って3秒後(ボールより自陣側 / 8m以内)');
  for (let k = 0; k < 2; k++) {
    const T = TR[k], nl = Math.max(1, sum(T.lost));
    console.log(`  チーム${k}   ${f1(sum(T.lost) / n).padStart(5)}回(${T.lost.map((v) => f1(v / n)).join('/')})   ${pc(sum(T.reg5) / nl)}(${pc(T.reg5[2] / Math.max(1, T.lost[2]))})   ${f1((100 * sum(T.shots8)) / nl)}/${f1((100 * sum(T.goals8)) / nl)}   ${f1(T.won / n).padStart(5)}回   ${f1((100 * T.wshots8) / Math.max(1, T.won))}   ${f1(T.prog4 / Math.max(1, T.progN))}m   ${f1(T.behind / Math.max(1, T.behindN))}人 / ${f1(T.oh / Math.max(1, T.ohN))}人   ${f1(T.r3b / Math.max(1, T.r3n))}人 / ${f1(T.r3c / Math.max(1, T.r3n))}人`);
  }
}
console.log('スタミナ（外野手の平均。1=万全）  前半の終わり → 試合の終わり   （最も疲れた選手）  ' + [0, 1].map((k) => `チーム${k} ${(STA[k].h1 / n).toFixed(2)} → ${(STA[k].end / n).toFixed(2)} (${STA[k].min.toFixed(2)})`).join('   '));
console.log('シュート（前半 / 後半）  ' + [0, 1].map((k) => `チーム${k} ${(SH[k][0] / n).toFixed(1)} / ${(SH[k][1] / n).toFixed(1)}`).join('   '));
console.log(`ボールが生きている時間 ${pc(ticksLive / Math.max(1, ticksAll))}（試合時間のうち、止まっている時間を除く）`);
if (ko) { const nk = pkRes[0] + pkRes[1] + pkRes[2]; console.log(`PK戦まで行った試合 ${pkMatches}/${n}` + (nk ? `  1本ごと: ゴール ${pc(pkRes[1] / nk)} セーブ ${pc(pkRes[2] / nk)} 外れ ${pc(pkRes[0] / nk)}（${nk}本）` : '')); }
console.log(`所要 ${sec.toFixed(1)} 秒（1試合 ${(sec / runs).toFixed(2)} 秒、${Math.round(allTicks / sec / 1000)}k tick/秒）${check ? `  再現性の不一致 ${bad} 件` : ''}`);
process.exit(bad ? 1 : 0);
