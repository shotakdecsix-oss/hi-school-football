// 形の測定（v21 ゾーン）: node tools/shape.js N MIN [home away] [--zones 0] [--tab]
// 局面ごと（A1 ビルドアップ・A2 運び/進入・A3 ファイナル／D1 相手のビルドアップ=高い位置・D2 中盤・D3 ゴール前）の平均位置、
// 形の指標（幅・縦の長さ・同じ升に2人）と、自陣で寄せられた保持者の出口の数を出す。
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
const R = process.env.SHAPE_R || new URL('../', import.meta.url).href; // 別の場所の版（git worktree など）と比べるときは SHAPE_R=その場所/ を付ける
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const N = +(args[0] || 20), MIN = +(args[1] || 90), HOME = args[2] || '4-4-2', AWAY = args[3] || HOME, ZONES = +flag('zones', 1), TAB = process.argv.includes('--tab');
const PH = ['A1', 'A2', 'A3', 'D1', 'D2', 'D3'];
if (isMainThread) {
  const jobs = []; for (let s = 1; s <= N; s++) jobs.push(s);
  const acc = { n: new Float64Array(6), fs: new Float64Array(60), gs: new Float64Array(60), w: new Float64Array(6), dp: new Float64Array(6), sh: new Float64Array(6), sl: new Float64Array(6), cen: new Float64Array(6), o: [0, 0, 0, 0, 0, 0], st: {} };
  let next = 0, alive = 2;
  const ws = [0, 1].map(() => new Worker(new URL(import.meta.url), { workerData: { HOME, AWAY, MIN, ZONES } }));
  for (const w of ws) {
    const give = () => { if (next < jobs.length) w.postMessage(jobs[next++]); else { w.terminate(); if (--alive === 0) done(); } };
    w.on('message', (r) => {
      for (let i = 0; i < 6; i++) { acc.n[i] += r.n[i]; acc.w[i] += r.w[i]; acc.dp[i] += r.dp[i]; acc.sh[i] += r.sh[i]; acc.sl[i] += r.sl[i]; acc.cen[i] += r.cen[i]; }
      for (let i = 0; i < 60; i++) { acc.fs[i] += r.fs[i]; acc.gs[i] += r.gs[i]; }
      for (let i = 0; i < 6; i++) acc.o[i] += r.o[i];
      for (const k in r.st) acc.st[k] = (acc.st[k] || 0) + r.st[k];
      give();
    });
    give();
  }
  function done() {
    const f1 = (x, d = 1) => (+x).toFixed(d);
    console.log(`${HOME} v ${AWAY} ${N}試合×${MIN}分 zones=${ZONES}`);
    for (let p = 0; p < 6; p++) {
      const n = acc.n[p] || 1;
      let row = PH[p] + ' ';
      for (let s = 1; s < 11; s++) row += ` ${f1(acc.fs[p * 10 + s - 1] / n, 0).padStart(3)}/${f1(acc.gs[p * 10 + s - 1] / n, 0).padStart(3)}`;
      console.log(row + ` | 幅${f1(acc.w[p] / n)} 縦${f1(acc.dp[p] / n)} 重心${f1(acc.cen[p] / n)} 同升${f1(acc.sh[p] / n, 2)} 同レーン${f1(acc.sl[p] / n, 2)} (n=${n})`);
    }
    const on = acc.o[0] || 1;
    console.log(`出口(自陣・寄せられ圧力>0.3の保持者): 場面${acc.o[0]} 出口数${f1(acc.o[1] / on, 2)} 安全な出口${f1(acc.o[2] / on, 2)} 最良の見込み${f1(acc.o[3] / on, 3)} 前向きの出口${f1(acc.o[4] / on, 2)} 近い(8-20m)出口${f1(acc.o[5] / on, 2)}`);
    console.log(Object.entries(acc.st).map(([k, v]) => `${k}=${f1(v / N, 1)}`).join(' '));
  }
} else {
  const { createMatch, stepMatch } = await import(R + 'engine/match.js');
  const { sampleInput } = await import(R + 'engine/sample.js');
  const { I, ST, ST_N, EV, F_B, PHASE, HL, HW, dirOf } = await import(R + 'engine/consts.js');
  const { laneSafe, pressureAt } = await import(R + 'engine/decide.js');
  const { passV0 } = await import(R + 'engine/geom.js');
  const { HOME, AWAY, MIN, ZONES } = workerData;
  parentPort.on('message', (seed) => {
    const inp = sampleInput(seed, { home: HOME, away: AWAY, abilHome: 10, abilAway: 10 });
    if (!ZONES) inp.zones = 0;
    const m = createMatch(inp);
    const r = { n: new Float64Array(6), fs: new Float64Array(60), gs: new Float64Array(60), w: new Float64Array(6), dp: new Float64Array(6), sh: new Float64Array(6), sl: new Float64Array(6), cen: new Float64Array(6), o: [0, 0, 0, 0, 0, 0], st: {} };
    while (m.t < MIN * 1200 && stepMatch(m)) {
      if (m.N[I.PHASE] !== PHASE.LIVE || m.t % 10) continue;
      const own = m.N[I.OWN], P = own >= 0 ? m.team[own] : m.N[I.POSS];
      if (P < 0) continue;
      for (let k = 0; k < 2; k++) {
        const dir = dirOf(m.N, k), bf = m.F[F_B] * dir, att = P === k;
        const p = att ? (bf < -17.5 ? 0 : bf < 17.5 ? 1 : 2) : (bf > 17.5 ? 3 : bf > -17.5 ? 4 : 5);
        r.n[p]++;
        let lo = 1e9, hi = -1e9, ymin = 1e9, ymax = -1e9, sf = 0; const cells = new Map(), lanes = new Map();
        for (let s = 1; s < 11; s++) {
          const i = k * 11 + s, f = m.px[i] * dir + HL, g = m.py[i] * dir, sg = m.fl[i] > 0.05 ? 1 : m.fl[i] < -0.05 ? -1 : 0;
          r.fs[p * 10 + s - 1] += f; r.gs[p * 10 + s - 1] += sg === 0 ? Math.abs(g) : g * sg;
          lo = Math.min(lo, f); hi = Math.max(hi, f); ymin = Math.min(ymin, g); ymax = Math.max(ymax, g); sf += f;
          const row = Math.min(9, Math.max(0, Math.floor(f / 10.5))), lane = Math.min(4, Math.max(0, Math.floor((g + HW) / 13.6)));
          cells.set(row * 5 + lane, (cells.get(row * 5 + lane) || 0) + 1); 
        }
        r.w[p] += ymax - ymin; r.dp[p] += hi - lo; r.cen[p] += sf / 10;
        let sh = 0; for (const v of cells.values()) if (v > 1) sh += v - 1; r.sh[p] += sh;
        let sl = 0; const lc = new Map(); for (let s = 1; s < 11; s++) { const i = k * 11 + s, g = m.py[i] * dir, f = m.px[i] * dir + HL, lane = Math.min(4, Math.max(0, Math.floor((g + HW) / 13.6))), band = Math.floor(f / 21); const kk = lane + 5 * band; lc.set(kk, (lc.get(kk) || 0) + 1); }
        for (const v of lc.values()) if (v > 1) sl += v - 1; r.sl[p] += sl;
      }
      // 出口: 自陣（攻める向きで -17.5m より後ろ）で、圧力が 0.3 を超える保持者
      if (own >= 0 && m.slot[own] !== 0) {
        const k = m.team[own], dir = dirOf(m.N, k), bf = m.F[F_B] * dir;
        if (bf < -17.5 && pressureAt(m, m.px[own], m.py[own], k) > 0.3) {
          let nOut = 0, nSafe = 0, best = 0, nFwd = 0, nNear = 0;
          for (let s = 0; s < 11; s++) {
            const j = k * 11 + s; if (j === own) continue;
            const dx = m.px[j] - m.px[own], dy = m.py[j] - m.py[own], D = Math.sqrt(dx * dx + dy * dy);
            if (D < 6 || D > 35) continue;
            const sf = laneSafe(m, k, m.px[own], m.py[own], m.px[j], m.py[j], passV0(D));
            let dm = 1e9; for (let q = (1 - k) * 11; q < (1 - k) * 11 + 11; q++) { const ex = m.px[q] - m.px[j], ey = m.py[q] - m.py[j]; dm = Math.min(dm, ex * ex + ey * ey); }
            const free = Math.sqrt(dm) > 3.5, q = sf * (free ? 1 : 0.5);
            if (sf > 0.5) nOut++; if (sf > 0.7 && free) nSafe++; if (q > best) best = q; if (sf > 0.7 && free && dx * dir > 2) nFwd++; if (sf > 0.7 && free && D <= 20) nNear++;
          }
          r.o[0]++; r.o[1] += nOut; r.o[2] += nSafe; r.o[3] += best; r.o[4] += nFwd; r.o[5] += nNear;
        }
      }
    }
    const S = m.N, g = (k, key) => S[I.ST + k * ST_N + ST[key]];
    for (const key of ['PASS', 'PASSOK', 'CLR', 'CORNER', 'LOB']) r.st[key] = (r.st[key] || 0) + g(0, key) + g(1, key);
    for (const [nm, ev] of [['shots', EV.SHOT], ['goals', EV.GOAL], ['outs', EV.OUT]]) r.st[nm] = (r.st[nm] || 0) + m.log.filter((e) => e[1] === ev).length;
    parentPort.postMessage(r);
  });
}
