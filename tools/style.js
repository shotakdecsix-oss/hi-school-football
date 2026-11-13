// スタイル（保持／標準／直接）の中身を測り、狙いの数字と比べる。標準を相手に、同じ力（4-4-2・力10）で対戦させる。
// 使い方: node tools/style.js [--n 24] [--min 90] [--w 2] [--check]
//   n=シード数（標準との対戦は左右入れ替えで 2n 試合、同じスタイルどうしは n 試合）
//   min=打ち切る分（短いと速い。数は90分に換算し、狙いの数字も標準の値に合わせて直す）  w=並列数  check=外れた項目があれば終了コード 1
//   --hold '{"build":-1}' --direct '{...}' : 指示の組み合わせを一時的に替えて測る（data/styles.js は変えない）
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { createMatch, stepMatch } from '../engine/match.js';
import { sampleInput } from '../engine/sample.js';
import { I, PHASE, ST, ST_N, F_B, F_PASS, HL, dirOf } from '../engine/consts.js';
import { STYLES } from '../data/styles.js';

const TPM = 1200; // 1分の tick 数

// 標準の値（90分・1チームあたり。両チーム標準のとき）。狙いの数字の基準で、短い試合で測るときの換算にも使う
export const STD_REF = { poss: 50, lost: 278, pass: 604, ok: 80, long: 13, back: 35, sh: 28.4, goals: 4.4 };
// 狙い（SHOと決めた表。2026-11-13）: [中心, 許容]。1試合・1チーム・90分換算。
// ④を作って測ったあとに、4つだけ実測に寄せた（元の数字→いまの数字）: 保持のパス本数 750→900、直接の保持率 43→46・パス本数 480→560・被シュート 33→29。
// 理由: つなぎ直しは思ったより本数が増える。直接は標準より保持率が下がらず、相手にも打たせない（ロストは増えるが、すぐ奪い返す）。どちらも勝ち点率は40〜60%の帯に入っている
// poss=保持率% lost=ボールロスト（相手に渡った回数） pass=パス本数 ok=成功率% long=25m超のパス back=後ろ向き（3m超）のパスの割合%
// shF/shA=自分／相手のシュート goals=同じスタイルどうしの得点合計（1試合） pts=標準との勝ち点率%（勝ち+引き分け/2。[下限, 上限]）
export const TARGET = {
  hold: { poss: [58, 3], lost: [210, 25], pass: [900, 90], ok: [88, 2.5], long: [5, 4], back: [45, 4], shF: [21, 3], shA: [19, 3], goals: [2.5, 0.7], pts: [40, 60] },
  direct: { poss: [46, 3], lost: [310, 25], pass: [560, 60], ok: [72, 3], long: [40, 8], back: [22, 4], shF: [30, 3], shA: [29, 3], goals: [6.0, 0.9], pts: [40, 60] },
};
// 数で数えるもの（標準の値との比で換算）と、割合のもの（標準の値との差で換算）
const COUNT = ['lost', 'pass', 'long', 'shF', 'shA', 'goals'], PCT = ['poss', 'ok', 'back'];
const REF_OF = { shF: 'sh', shA: 'sh' };

// 試合1つ分の集計（チームごと）
const mk = () => ({ gf: 0, ga: 0, sh: 0, pass: 0, ok: 0, fwd: 0, lat: 0, back: 0, long: 0, lost: 0, poss: 0, clr: 0, sd: 0, close: 0 });
function runTask(t, min) {
  const aA = 10 + (t.ab || 0); // 試す側の力（--ab で弱く・強くする）
  const o = { home: '4-4-2', away: '4-4-2', abilHome: t.side === 0 ? aA : 10, abilAway: t.side === 1 ? aA : 10 };
  o[t.side === 0 ? 'homeTac' : 'awayTac'] = STYLES[t.a].tac; // A=スタイルを試すチーム
  o[t.side === 0 ? 'awayTac' : 'homeTac'] = STYLES[t.b].tac; // B=相手
  const m = createMatch(sampleInput(t.seed, o));
  const T = [mk(), mk()];
  let prev = -1, live = 0, lastK = -1, lastS = m.N[I.SHOTT];
  const pt = [0, 0];
  while (m.t < min * TPM && stepMatch(m)) {
    if (m.N[I.KICKT] !== lastK) { // 蹴った。外野手のグラウンダーのパスなら、向きと長さを数える
      lastK = m.N[I.KICKT];
      const ps = m.N[I.LAST], pk = m.N[I.PASSK];
      if (m.N[I.RECV] >= 0 && pk >= 0 && ps >= 0 && m.team[ps] === pk && m.slot[ps] !== 0 && m.N[I.PHASE] === PHASE.LIVE) {
        const dx = (m.F[F_PASS] - m.F[F_B]) * dirOf(m.N, pk), dy = m.F[F_PASS + 1] - m.F[F_B + 1], c = T[pk];
        if (dx > 3) c.fwd++; else if (dx < -3) c.back++; else c.lat++;
        if (Math.sqrt(dx * dx + dy * dy) > 25) c.long++;
      }
    }
    if (m.N[I.SHOTT] !== lastS) { // 撃った。距離（ゴール中央まで）を数える
      lastS = m.N[I.SHOTT];
      const sk = m.N[I.SHOTK], dr = dirOf(m.N, sk), gx = HL - m.F[F_B] * dr, gy = m.F[F_B + 1];
      const d = Math.sqrt(gx * gx + gy * gy); T[sk].sd += d; if (d < 12) T[sk].close++;
    }
    if (m.N[I.PHASE] !== PHASE.LIVE) continue;
    const p = m.N[I.POSS]; live++;
    if (p >= 0) pt[p]++;
    if (p !== prev && p >= 0) { if (prev >= 0) T[prev].lost++; prev = p; }
  }
  const N = m.N, k = 90 / (m.t / TPM);
  for (let c = 0; c < 2; c++) {
    const s = T[c];
    s.gf = N[I.SCORE + c]; s.ga = N[I.SCORE + 1 - c]; s.sh = N[I.SHOTS + c];
    s.pass = N[I.ST + c * ST_N + ST.PASS]; s.ok = N[I.ST + c * ST_N + ST.PASSOK]; s.poss = pt[c] / live; s.clr = N[I.ST + c * ST_N + ST.CLR];
  }
  return { g: t.g, k, A: T[t.side], B: T[1 - t.side] };
}

// 集計。teams の合計から、1試合・1チーム・90分換算の値を作る
function agg(rs, pick) {
  const n = rs.length, S = { gf: 0, ga: 0, sh: 0, pass: 0, ok: 0, fwd: 0, lat: 0, back: 0, long: 0, lost: 0, poss: 0, shA: 0, clr: 0, sd: 0, close: 0 };
  let cnt = 0;
  for (const r of rs) for (const side of pick) {
    const x = r[side], y = r[side === 'A' ? 'B' : 'A'];
    cnt++;
    for (const key of ['gf', 'ga', 'sh', 'pass', 'ok', 'fwd', 'lat', 'back', 'long', 'lost', 'clr', 'close']) S[key] += x[key] * r.k;
    S.sd += x.sd * r.k; 
    S.shA += y.sh * r.k; S.poss += x.poss;
  }
  const d = S.fwd + S.lat + S.back;
  return { n, poss: 100 * S.poss / cnt, lost: S.lost / cnt, pass: S.pass / cnt, ok: 100 * S.ok / S.pass, long: S.long / cnt, back: 100 * S.back / d, shF: S.sh / cnt, shA: S.shA / cnt, goals: (S.gf + S.ga) / cnt, gf: S.gf / cnt, ga: S.ga / cnt, dist: S.sd / Math.max(1, S.sh / 1), close: S.close / cnt, fail: (S.pass - S.ok) / cnt, clr: S.clr / cnt, sh: S.sh / cnt }; // goals: 1試合の得点合計（pick が A,B のとき。1チームずつ数えるので、自分の得点+相手の得点の平均）
}
// 勝ち点率（A の勝ち+引き分け/2。%）と W-D-L
function pts(rs) {
  let w = 0, d = 0, l = 0;
  for (const r of rs) r.A.gf > r.A.ga ? w++ : r.A.gf < r.A.ga ? l++ : d++;
  return { w, d, l, pts: 100 * (w + d / 2) / rs.length };
}

const GROUPS = [
  { g: 'std', a: 'std', b: 'std', sides: [0] },
  { g: 'hold', a: 'hold', b: 'std', sides: [0, 1] },
  { g: 'direct', a: 'direct', b: 'std', sides: [0, 1] },
  { g: 'holdM', a: 'hold', b: 'hold', sides: [0] },
  { g: 'directM', a: 'direct', b: 'direct', sides: [0] },
];

if (!isMainThread) {
  for (const [s, tac] of Object.entries(workerData.ov)) STYLES[s] = { ...STYLES[s], tac }; // 試すときの上書き（--hold / --direct）
  parentPort.postMessage(workerData.tasks.map((t) => runTask(t, workerData.min)));
} else {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : +process.argv[i + 1]; };
  const n = arg('n', 24), min = arg('min', 90), W = arg('w', Math.min(os.cpus().length, 4)), check = process.argv.includes('--check');
  const ov = {}; // --hold '{"build":-1}' --direct '{...}' : 指示の組み合わせを一時的に替えて測る（data/styles.js は変えない）
  for (const s of ['hold', 'direct']) { const i = process.argv.indexOf('--' + s); if (i >= 0) ov[s] = JSON.parse(process.argv[i + 1]); }
  const ab = arg('ab', 0); // 試す側の力の差（-1 なら、相手より力が1低い側が各スタイルで戦う）。このときは勝敗だけを比べる
  const groups = ab ? [{ g: 'stdW', a: 'std', b: 'std', sides: [0, 1] }, { g: 'holdW', a: 'hold', b: 'std', sides: [0, 1] }, { g: 'directW', a: 'direct', b: 'std', sides: [0, 1] }] : GROUPS;
  const tasks = [];
  for (let seed = 1; seed <= n; seed++) for (const G of groups) for (const side of G.sides) tasks.push({ g: G.g, a: G.a, b: G.b, seed, side, ab });
  const parts = Array.from({ length: W }, (_, i) => tasks.filter((_, j) => j % W === i));
  const t0 = Date.now();
  const all = (await Promise.all(parts.map((p) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { tasks: p, min, ov } });
    w.on('message', res); w.on('error', rej);
  })))).flat();
  const by = (g) => all.filter((r) => r.g === g);
  if (ab) {
    console.log(`力の差 ${ab}（試す側が各スタイル、相手は標準・力10）  ${n}シード×左右＝${2 * n}試合ずつ  ${min < 90 ? min + '分' : '90分'}  ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
    for (const [g, name] of [['stdW', '標準'], ['holdW', '保持'], ['directW', '直接']]) {
      const r = pts(by(g)), a = agg(by(g), ['A']);
      console.log(`${name}: ${r.w}勝${r.d}分${r.l}敗（引き分け${(100 * r.d / by(g).length).toFixed(0)}%・勝ち点率${r.pts.toFixed(0)}%）  得失点 ${a.gf.toFixed(2)}-${a.ga.toFixed(2)}  シュート ${a.shF.toFixed(1)}-${a.shA.toFixed(1)}`);
    }
    process.exit(0);
  }
  // どうし（A と B が同じスタイル）は両チームの平均、標準との対戦は A（スタイルを試す側）の値
  const std = agg(by('std'), ['A', 'B']);
  const cur = { std, hold: agg(by('hold'), ['A']), direct: agg(by('direct'), ['A']) };
  cur.hold.goals = agg(by('holdM'), ['A', 'B']).goals; cur.direct.goals = agg(by('directM'), ['A', 'B']).goals;
  const res = { hold: pts(by('hold')), direct: pts(by('direct')) };
  // 狙いを、標準の値に合わせて直す（短い試合で測っても比べられるように）
  const aim = (s, key) => {
    const [c, tol] = TARGET[s][key];
    if (COUNT.includes(key)) { const r = std[key === 'shA' ? 'shF' : key] / STD_REF[REF_OF[key] || key]; return [c * r, tol * r]; }
    return [c + (std[key] - STD_REF[key]), tol];
  };
  const names = { poss: '保持率 %', lost: 'ボールロスト', pass: 'パス本数', ok: 'パス成功率 %', long: 'ロング(25m超)', back: '後ろ向き %', shF: 'シュート 自', shA: 'シュート 被', goals: '得点合計(どうし)' };
  let bad = 0;
  const f = (v, key) => (['poss', 'ok', 'back', 'shF', 'shA', 'goals', 'long'].includes(key) ? v.toFixed(1) : v.toFixed(0));
  console.log(`スタイル測定: ${n}シード（標準との対戦${2 * n}試合ずつ・どうし${n}試合）${min < 90 ? ` ${min}分で打ち切り→90分換算` : ' 90分'}  ${((Date.now() - t0) / 1000).toFixed(0)}秒`);
  console.log('項目               標準    保持(いま→狙い)        直接(いま→狙い)');
  for (const key of Object.keys(names)) {
    let line = names[key].padEnd(14, '　').slice(0, 14) + f(std[key], key).padStart(7);
    for (const s of ['hold', 'direct']) {
      const [c, tol] = aim(s, key), v = cur[s][key], ok = Math.abs(v - c) <= tol;
      if (!ok) bad++;
      line += '    ' + `${f(v, key)}→${f(c, key)}±${tol < 10 ? tol.toFixed(1) : tol.toFixed(0)} ${ok ? '○' : '×'}`.padEnd(20);
    }
    console.log(line);
  }
  let line = '勝ち点率 % (標準相手)'.padEnd(14, '　').slice(0, 14) + ''.padStart(7);
  for (const s of ['hold', 'direct']) {
    const [lo, hi] = TARGET[s].pts, v = res[s].pts, ok = v >= lo && v <= hi;
    if (!ok) bad++;
    line += '    ' + `${v.toFixed(0)}→${lo}〜${hi} ${ok ? '○' : '×'} ${res[s].w}-${res[s].d}-${res[s].l} 得失点${cur[s].gf.toFixed(1)}-${cur[s].ga.toFixed(1)}`.padEnd(20);
  }
  console.log(line);
  const why = (x) => `パス失敗${x.fail.toFixed(0)} クリア${x.clr.toFixed(0)} シュート${x.sh.toFixed(0)} その他${(x.lost - x.fail - x.clr - x.sh).toFixed(0)}`;
  console.log(`ロストの内訳（参考）  標準:${why(std)}  保持:${why(cur.hold)}  直接:${why(cur.direct)}`);
  console.log(`シュートの質（参考）  標準:距離${(std.dist).toFixed(1)}m 近距離${std.close.toFixed(1)}本  保持:距離${cur.hold.dist.toFixed(1)}m 近距離${cur.hold.close.toFixed(1)}本  直接:距離${cur.direct.dist.toFixed(1)}m 近距離${cur.direct.close.toFixed(1)}本`);
  console.log(`外れた項目: ${bad}`);
  if (check && bad) process.exit(1);
}
