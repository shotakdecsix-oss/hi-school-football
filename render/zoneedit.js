// ゾーン編集（試合ビューアの「ゾーン配置（自分で設定）」）の部品。DOM に触らない関数だけ（tools/test.js の zoneedit: で試験する）。
// 表 = data/zones.js の1陣形ぶん { att: [3局面][10人の升の文字列], def: [...] }。升は '3b' = 行3・レーンb（行は自陣ゴールライン側が 0、レーンは a=左〜e=右）。
// エンジンへは、チームの入力 teams[k].zones にこの表をそのまま入れる（engine/zones.js の buildZones が検査する）。
import { HL, HW } from '../engine/consts.js';
import { ZONES } from '../data/zones.js';
import { FORMATIONS } from '../data/formations.js';

export const ZMAX = 3; // 1人の領域の升の数の上限（1〜3）
export const LAN = 'abcde';
export const ZCOL = ['#8b949e', '#4c8dff', '#2fb5b5', '#7fb83a', '#e0a030', '#f0623e', '#b06be0', '#e0559a']; // 役割の色（data/formations.js の ROLE の番号順）
const RNAME = ['GK', 'CB', 'SB', '守MF', 'MF', 'W', '攻MF', 'FW'];
export const QLAB = [['①ビルドアップ', '②運び・進入', '③ファイナルサード'], ['①相手のビルドアップ', '②中盤', '③低いブロック']];
export const QHINT = ['ボールの位置　①自陣　②中盤　③敵陣', 'ボールの位置　①敵陣側（こちらは高い位置）　②中盤　③自陣側（低いブロック）'];
export const GRID = { CW: 52, CH: 34, GX: 28, GY: 16 }; // 升の幅・高さ・左と上の余白（図の座標）

const CELL = /^[0-9][a-e]( [0-9][a-e]){0,2}$/;
const n = (v) => +v.toFixed(1);

// 表の形が正しいか（att・def それぞれ 3局面 × 10人 × 升1〜3個）
export const tabOk = (t) => !!t && ['att', 'def'].every((s) => Array.isArray(t[s]) && t[s].length === 3 && t[s].every((r) => Array.isArray(r) && r.length === 10 && r.every((c) => typeof c === 'string' && CELL.test(c))));
export const tabClone = (t) => JSON.parse(JSON.stringify(t));
export const tabDefault = (f) => tabClone(ZONES[f]);

// 1人の領域 str（'3a 4a 4b'）に、升 code を足す／外す。最後の1升は外せない。max を超えたら、いちばん古い（先頭の）升が外れる
export function toggleCell(str, code, max = ZMAX) {
  const a = str.split(' '), i = a.indexOf(code);
  if (i >= 0) { if (a.length > 1) a.splice(i, 1); } else { a.push(code); if (a.length > max) a.shift(); }
  return a.join(' ');
}

// 領域 → 升の中心の平均（r=行・l=レーン。小数）と外側の四角（行 r0..r1・レーン l0..l1）
export function regionOf(str) {
  const a = str.split(' ');
  let sr = 0, sl = 0, r0 = 9, r1 = 0, l0 = 4, l1 = 0;
  for (const c of a) { const r = +c[0], l = LAN.indexOf(c[1]); sr += r; sl += l; if (r < r0) r0 = r; if (r > r1) r1 = r; if (l < l0) l0 = l; if (l > l1) l1 = l; }
  return { r: sr / a.length, l: sl / a.length, r0, r1, l0, l1 };
}

// 升ごとのカバー人数 c[行×5+レーン]: 1局面の10人の領域（選んだ升の外側の四角。エンジンが持ち場の限界にするのと同じ）に、その升が入る人数。GK は表にないので数えない
export function coverage(rows) {
  const c = new Array(50).fill(0);
  for (const str of rows) { const g = regionOf(str); for (let r = g.r0; r <= g.r1; r++) for (let l = g.l0; l <= g.l1; l++) c[r * 5 + l]++; }
  return c;
}
// 誰もいない（0人）・1人・重なり（2人以上）の升の数
export function coverCount(c) {
  let none = 0, one = 0, multi = 0;
  for (const v of c) { if (v === 0) none++; else if (v === 1) one++; else multi++; }
  return { none, one, multi };
}
// 升の色: 0人=斜線（暗い赤。目立たせすぎない）・1人=緑・2人=黄土・3人=橙・4人以上=赤橙。2人以上は升の隅に人数の数字も出す
export const COVCOL = ['url(#znHatch)', '#1c5b36', '#8a6d14', '#b5651a', '#cc4a1f'];
const HATCH = 'repeating-linear-gradient(45deg,#1b1517 0 3px,#6e3636 3px 5px)';
// 凡例（HTML の文字列）: 色の見本と、その局面の升の数
export function coverLegend(rows) {
  const k = coverCount(coverage(rows)), sw = (bg) => `<i style="display:inline-block;width:12px;height:12px;vertical-align:-2px;margin:0 3px 0 0;border:1px solid #484f58;background:${bg}"></i>`;
  return `${sw(HATCH)}誰もいない ${k.none}升　${sw(COVCOL[1])}1人 ${k.one}升　${sw(`linear-gradient(90deg,${COVCOL[2]},${COVCOL[3]},${COVCOL[4]})`)}重なり ${k.multi}升（数字=人数）`;
}

// 選手 s（0..9 = 外野手のスロット 1..10）の呼び名（'SB左'）と色
export function slotLabel(f, s) {
  const d = FORMATIONS[f][s + 1];
  return RNAME[d[2]] + (d[1] < -0.15 ? '左' : d[1] > 0.15 ? '右' : '');
}
export const slotColor = (f, s) => ZCOL[FORMATIONS[f][s + 1][2]];

// 1陣形の表を、data/zones.js にそのまま貼れる書式の文字列にする（升は行・レーンの順に並べる）
export function tabText(f, t) {
  const rows = (rs) => rs.map((r) => `      [${r.map((c) => `'${c.split(' ').sort().join(' ')}'`).join(', ')}],`).join('\n');
  return `  '${f}': {\n    att: [\n${rows(t.att)}\n    ],\n    def: [\n${rows(t.def)}\n    ],\n  },`;
}

// 編集用の升の図（SVG の文字列）。攻める向きが上・左が選手から見て左。選んだ選手 sel の升を枠と色で示し、外側の四角を点線で、全員の立つ目安を番号の丸で描く。
// opt.cover（既定 true）: 升をカバー人数で塗る（誰もいない=斜線・1人=緑・重なり=黄土〜赤橙と人数の数字）。false なら一色
// 升は data-z="c:3b"（クリックで toggleCell）。選んだ升の枠は data-sel="1"。丸・線・数字は pointer-events なし（下の升を押せる）
export function gridSvg(f, t, side, q, sel, opt = {}) {
  const { CW, CH, GX, GY } = GRID, rows = t[side ? 'def' : 'att'][q], W = GX + 5 * CW + 6, H = GY + 10 * CH + 28, mine = rows[sel].split(' ');
  const cover = opt.cover !== false, cv = coverage(rows), col = slotColor(f, sel);
  let g = `<svg id="znSv" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`, nums = '';
  if (cover) g += '<defs><pattern id="znHatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#1b1517"/><path d="M0 0V8" stroke="#6e3636" stroke-width="1.6"/></pattern></defs>';
  for (let r = 9; r >= 0; r--) {
    const y = GY + (9 - r) * CH;
    g += `<text x="${GX - 6}" y="${y + CH / 2 + 4}" text-anchor="end" font-size="11" fill="#8b949e">${r}</text>`;
    for (let l = 0; l < 5; l++) {
      const v = cv[r * 5 + l], x = GX + l * CW;
      g += `<rect data-z="c:${r}${LAN[l]}" x="${x}" y="${y}" width="${CW}" height="${CH}" fill="${cover ? COVCOL[Math.min(v, 4)] : '#12301f'}" stroke="#25503a"/>`;
      if (cover && v >= 2) nums += `<text x="${x + CW - 5}" y="${y + 12}" text-anchor="end" font-size="10" fill="#ffe9b0" pointer-events="none">${v}</text>`;
    }
  }
  for (const c of mine) g += `<rect data-sel="1" x="${GX + LAN.indexOf(c[1]) * CW + 1}" y="${GY + (9 - +c[0]) * CH + 1}" width="${CW - 2}" height="${CH - 2}" fill="${col}" fill-opacity="${cover ? 0.3 : 0.6}" stroke="${col}" stroke-width="2" pointer-events="none"/>`;
  g += nums;
  for (let l = 0; l < 5; l++) g += `<text x="${GX + (l + 0.5) * CW}" y="${GY + 10 * CH + 14}" text-anchor="middle" font-size="11" fill="#8b949e">${LAN[l]}${l === 0 ? ' 左' : l === 4 ? ' 右' : ''}</text>`;
  g += `<text x="${GX + 2.5 * CW}" y="11" text-anchor="middle" font-size="10" fill="#8b949e">↑ 攻める向き（相手ゴール）</text>`;
  g += `<text x="${GX + 2.5 * CW}" y="${H - 3}" text-anchor="middle" font-size="10" fill="#8b949e">自陣ゴール</text>`;
  // ピッチの線: ハーフウェイライン・ペナルティエリア（目印）
  const lw = 2 * HW / 5, bx = GX + (HW - 20.15) / lw * CW, bw = 40.3 / lw * CW, bh = 16.5 / (2 * HL / 10) * CH;
  g += `<g fill="none" stroke="#6b9a7c" stroke-width="1.2" pointer-events="none"><path d="M${GX} ${GY + 5 * CH}h${5 * CW}"/><rect x="${n(bx)}" y="${n(GY + 10 * CH - bh)}" width="${n(bw)}" height="${n(bh)}"/><rect x="${n(bx)}" y="${GY}" width="${n(bw)}" height="${n(bh)}"/></g>`;
  // 選んだ選手の領域（外側の四角）
  const rg = regionOf(rows[sel]);
  g += `<rect x="${GX + rg.l0 * CW}" y="${GY + (9 - rg.r1) * CH}" width="${(rg.l1 - rg.l0 + 1) * CW}" height="${(rg.r1 - rg.r0 + 1) * CH}" fill="none" stroke="#fff" stroke-width="1.6" stroke-dasharray="5 3" pointer-events="none"/>`;
  const dot = (s) => {
    const p = regionOf(rows[s]), on = s === sel, cx = GX + (p.l + 0.5) * CW, cy = GY + (9.5 - p.r) * CH;
    return `<g pointer-events="none"><circle cx="${n(cx)}" cy="${n(cy)}" r="${on ? 11 : 8}" fill="${slotColor(f, s)}" stroke="${on ? '#fff' : '#0d1117'}" stroke-width="${on ? 2 : 1}"/><text x="${n(cx)}" y="${n(cy + 4)}" text-anchor="middle" font-size="${on ? 12 : 10}" font-weight="700" fill="#fff">${s + 2}</text></g>`; // 丸の番号は、ピッチに出る背番号（GK が1番・外野手は 2〜11）
  };
  for (let s = 0; s < 10; s++) if (s !== sel) g += dot(s);
  return g + dot(sel) + '</svg>';
}
