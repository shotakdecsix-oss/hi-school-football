// ゾーン表（data/zones.js）の下書きを作る道具。従来の持ち場の式（v20。brain.js の zones:0 の式）を、局面のキーフレーム（ボール -35 / 0 / +35 m）で計算して、升の表にする（等価の出発点）。
//   node tools/genzones.js --eq --v21 > out.txt    （v21 の data/zones.js の中身はこれで作った）
// --eq: 従来の式の位置をそのまま升へ（統計は v20 と同じ）／ --v21: そのうえで ビルドアップの中盤を自陣 27m までに・守備のブロックを詰める（最終ライン 47/36/16m・縦の間隔 ×0.7）／ --withSB: SBの上がり・絞りを含める（既定は含めない＝エンジンが後から足す）
// 従来の式の定数（KX_ATT など）を写してあるので、brain.js の式を変えたら合わせる。新しい陣形の表の出発点に使う（出てきた表は手で直してよい）
const R = new URL('../', import.meta.url).href;
const { FORMATIONS, ROLE } = await import(R + 'data/formations.js');
const HL = 52.5, HW = 34, ZR = 10.5, ZL = 13.6;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const KX_ATT = [0, 0.95, 1.2, 0.85, 1, 1, 1, 1], KX_DEF = [0, 0.95, 0.95, 1, 1, 1, 0.9, 0.65];
const NAME = ['G', 'C', 'S', 'D', 'M', 'W', 'A', 'F'], JP = { G: 'GK', C: 'CB', S: 'SB', D: '守MF', M: 'MF', W: 'W', A: '攻MF', F: 'FW' };
const LANE = 'abcde';
const V21 = process.argv.includes('--v21');
const withSB = process.argv.includes('--withSB'); // SB_UP・tuck を含めるか（既定: 含めない = エンジンが後から足す）
function homes(form, att, sfx) {
  const fo = FORMATIONS[form]; let sx = 0; for (let s = 1; s < 11; s++) sx += -HL + fo[s][0] * 2 * HL; const cx0 = sx / 10;
  const out = [];
  const shiftA = clamp(0.6 * (sfx - cx0) + 8, -8, 24), shiftD = clamp(0.55 * (sfx - cx0) - 2, -22, 8);
  for (let s = 1; s < 11; s++) {
    const [fd, fl, r] = fo[s];
    const compr = att ? 0.92 : 0.78;
    let f = cx0 + (-HL + fd * 2 * HL - cx0) * compr + (att ? shiftA * KX_ATT[r] : shiftD * KX_DEF[r]);
    let g = fl * HW * 0.9 * (att ? (r === ROLE.W || r === ROLE.S ? 1.05 : 0.96) : 0.8);
    if (att && r === ROLE.S && withSB) { const w = clamp((sfx + 15) / 45, 0, 1), near = 0.5; f += 15 * w * (0.35 + 0.65 * near); g *= 1 - 0.35 * (1 - near) * w; }
    g = g + (0 - g) * (att ? 0.12 : 0.42);
    if (!att && r <= ROLE.D) f = Math.max(f, -HL + 13);
    f = clamp(f, -HL + 4, HL - 3);
    let fa = f + HL;
    if (V21 && att && sfx < -17 && (r === ROLE.D || r === ROLE.M)) fa = Math.min(fa, 27); // ビルドアップ: 中盤は CB の近く（10m 前）で受ける
    if (att && !process.argv.includes('--eq') && !V21) {
      const q = sfx < -17 ? 0 : sfx < 17 ? 1 : 2;
      if (r === ROLE.S) { fa = [34, 50, 54][q]; g = Math.sign(fl) * 27; }
      else if (r === ROLE.C) g = fl * [45, 33, 30][q];
      else if (r === ROLE.W) g = Math.sign(fl) * Math.min(27.2, Math.abs(fl) * 34);
      else if (r === ROLE.F) g = fl * [50, 45, 36][q];
      else if (r === ROLE.M) g = fl * 45;
      else g = fl * 0;
    }
    out.push({ f: fa, g, r, fl });
  }
  if (V21 && !att) { // 守備: 最終ライン（CB・SB）を局面ごとの高さにそろえ、縦の間隔を 0.7 倍に詰める
    const back = out.filter((h) => h.r === ROLE.C || h.r === ROLE.S), ob = back.reduce((a, h) => a + h.f, 0) / back.length;
    const nb = sfx > 17 ? 47 : sfx > -17 ? 36 : 16;
    for (const h of out) h.f = Math.max(13, nb + (h.f - ob) * (h.r === ROLE.F ? 0.75 : 0.7));
  }
  return out;
}
const cellC = (r, l) => [(r + 0.5) * ZR, (l - 2) * ZL];
function pick(pos) {
  pos = { ...pos }; // 位置に近い 1〜3 個の連なった升
  const r0 = clamp(Math.floor(pos.f / ZR), 1, 9), l0 = clamp(Math.floor((pos.g + HW) / ZL), 0, 4);
  const nb = []; for (let r = Math.max(1, r0 - 1); r <= r0 + 1; r++) for (let l = l0 - 1; l <= l0 + 1; l++) if (r >= 0 && r < 10 && l >= 0 && l < 5) nb.push([r, l]);
  const adj = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;
  const sets = nb.map((c) => [c]);
  for (const a of nb) for (const b of nb) if (adj(a, b) && (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]))) sets.push([a, b]);
  for (const a of nb) for (const b of nb) for (const c of nb) { if (!(adj(a, b) && adj(b, c) && a !== c)) continue; const k = [a, b, c].map((x) => x[0] * 5 + x[1]).sort((x, y) => x - y); if (k[0] === a[0] * 5 + a[1] && k[1] === b[0] * 5 + b[1] || true) sets.push([a, b, c]); }
  let best = null, bs = 1e9;
  for (const S of sets) {
    const u = new Set(S.map((x) => x[0] * 5 + x[1])); if (u.size !== S.length) continue;
    let af = 0, ag = 0; for (const [r, l] of S) { const [cf, cg] = cellC(r, l); af += cf; ag += cg; } af /= S.length; ag /= S.length;
    if (Math.abs(pos.fl) > 0.05 && Math.sign(ag) !== Math.sign(pos.fl)) continue; // 左右の選手は、自分の側に立つ
    if (Math.abs(pos.fl) <= 0.05 && Math.abs(ag) > 0.5) continue; // 中央の選手は、中央に立つ
    const sc = Math.hypot(af - pos.f, ag - pos.g) + 2.5 * (S.length - 1);
    if (sc < bs - 1e-9) { bs = sc; best = S; }
  }
  best = best.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return best.map(([r, l]) => r + LANE[l]).join(' ');
}
const KF = [-35, 0, 35];
let txt = '';
for (const form of Object.keys(FORMATIONS)) {
  const fo = FORMATIONS[form];
  txt += `  '${form}': {\n    // スロット順: ${fo.slice(1).map((d, i) => `${i + 1}${JP[NAME[d[2]]]}${d[1] < -0.05 ? '左' : d[1] > 0.05 ? '右' : ''}`).join(' ')}\n`;
  for (const side of ['att', 'def']) {
    txt += `    ${side}: [\n`;
    const ord = side === 'att' ? [0, 1, 2] : [2, 1, 0]; // 攻撃: ボール自陣→敵陣。守備: 相手のビルドアップ（ボール敵陣）→ゴール前
    for (const q of ord) {
      const H = homes(form, side === 'att', KF[q]);
      txt += `      [${H.map((h) => `'${pick(h)}'`).join(', ')}],\n`;
    }
    txt += '    ],\n';
  }
  txt += '  },\n';
}
process.stdout.write(txt);
