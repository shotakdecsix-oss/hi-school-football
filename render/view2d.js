// 試合の2D描画（上から見た図）。エンジンの内部は見ず、engine/match.js の frame() が返す形だけを受け取る。
import { HL, HW, GOAL_HW, PA_D, PA_HW, GA_D, GA_HW, PEN_X, CIRCLE_R } from '../engine/consts.js';

const COL = ['#e8453c', '#3b7bf0'];
export const VIEWBOX = `${-HL - 4} ${-HW - 4} ${2 * HL + 8} ${2 * HW + 8}`;

let pitch = '';
export function pitchSvg() {
  if (pitch) return pitch;
  const L = 2 * HL, W = 2 * HW, bw = L / 14;
  let s = `<rect x="${-HL - 4}" y="${-HW - 4}" width="${L + 8}" height="${W + 8}" fill="#2e7d32"/>`;
  for (let i = 0; i < 14; i += 2) s += `<rect x="${-HL + i * bw}" y="${-HW}" width="${bw}" height="${W}" fill="#348a35"/>`;
  s += '<g fill="none" stroke="#fff" stroke-width="0.25">'
    + `<rect x="${-HL}" y="${-HW}" width="${L}" height="${W}"/>`
    + `<line x1="0" y1="${-HW}" x2="0" y2="${HW}"/><circle cx="0" cy="0" r="${CIRCLE_R}"/>`
    + `<rect x="${-HL}" y="${-PA_HW}" width="${PA_D}" height="${2 * PA_HW}"/><rect x="${HL - PA_D}" y="${-PA_HW}" width="${PA_D}" height="${2 * PA_HW}"/>`
    + `<rect x="${-HL}" y="${-GA_HW}" width="${GA_D}" height="${2 * GA_HW}"/><rect x="${HL - GA_D}" y="${-GA_HW}" width="${GA_D}" height="${2 * GA_HW}"/>`
    + `<rect x="${-HL - 2}" y="${-GOAL_HW}" width="2" height="${2 * GOAL_HW}"/><rect x="${HL}" y="${-GOAL_HW}" width="2" height="${2 * GOAL_HW}"/>`
    + '</g>'
    + `<circle cx="${-HL + PEN_X}" cy="0" r="0.3" fill="#fff"/><circle cx="${HL - PEN_X}" cy="0" r="0.3" fill="#fff"/>`;
  return (pitch = s);
}

// 役割（ACT の番号順）ごとの輪の色。0=持ち場 1=保持 2=プレス 3=カバー 4=マーク 5=サポート 6=裏抜け 7=受ける 8=関わり続ける 9=ボールを追う 10=隣に合わせて動く
export const ROLE_COL = ['#ffffff', '#ffe600', '#ff7800', '#ffaa3c', '#b45cf0', '#28d25e', '#00e0e0', '#ff40d0', '#9be29b', '#ff5050', '#6ea8ff'];
export const ROLE_LEGEND = '輪の色: 黄=保持 橙=プレス/カバー 紫=マーク 緑=サポート 水=裏抜け 桃=受ける 赤=追う 青=隣に合わせて動く 白=持ち場';

// 向き a・半角 h の扇（視野の図）。半径 r は図のための長さで、エンジンの視野に距離の限りはない
const R_VIEW = 24, SOFT = 0.5236; // 視野の端から 30° は、端へ向かって見えにくくなる（engine/percept.js）
const wedge = (x, y, a, h, r) => {
  const c = Math.cos, s = Math.sin, p = (v) => v.toFixed(2);
  return `M${p(x)} ${p(y)}L${p(x + r * c(a - h))} ${p(y + r * s(a - h))}A${r} ${r} 0 ${h > Math.PI / 2 ? 1 : 0} 1 ${p(x + r * c(a + h))} ${p(y + r * s(a + h))}Z`;
};

// opt.view: 認知の表示（0=なし 1=向きと、一人の選手（f.seeBy）の視野と見え方 2=向きと、全員の視野）。f.face がなければ（認知なし）何も出さない
export function actorsSvg(f, roles = false, opt = {}) {
  const view = f.face ? opt.view | 0 : 0, sb = f.seeBy ?? -1;
  let s = '';
  if (view) {
    const who = view === 2 ? Array.from({ length: 22 }, (_, i) => i) : sb >= 0 ? [sb] : [];
    for (const i of who) {
      const x = f.xy[2 * i], y = f.xy[2 * i + 1], col = view === 2 ? COL[i < 11 ? 0 : 1] : '#ffe600', h = f.fov[i];
      s += `<path d="${wedge(x, y, f.face[i], h, R_VIEW)}" fill="${col}" opacity="0.09"/>`
        + `<path d="${wedge(x, y, f.face[i], Math.max(0.1, h - SOFT), R_VIEW)}" fill="${col}" opacity="0.12"/>`;
    }
    if (view === 1 && sb >= 0) { // すぐそば（気配で分かる範囲）の輪と、視点の選手の印
      const x = f.xy[2 * sb].toFixed(2), y = f.xy[2 * sb + 1].toFixed(2);
      s += `<circle cx="${x}" cy="${y}" r="6" fill="none" stroke="#ffe600" stroke-width="0.12" stroke-dasharray="0.6 0.6" opacity="0.5"/>`
        + (f.own === sb ? '' : `<circle cx="${x}" cy="${y}" r="1.7" fill="none" stroke="#ffe600" stroke-width="0.25" stroke-dasharray="0.5 0.4"/>`);
    }
  }
  for (let i = 0; i < 22; i++) {
    const x = f.xy[2 * i].toFixed(2), y = f.xy[2 * i + 1].toFixed(2), gk = i % 11 === 0;
    const rc = roles && f.act ? ROLE_COL[f.act[i]] || '#fff' : gk ? '#ffd60a' : '#fff';
    if (f.own === i) s += `<circle cx="${x}" cy="${y}" r="2" fill="none" stroke="#ffe600" stroke-width="0.35" opacity="0.9"/>`;
    const dim = view === 1 && f.see && i !== sb ? 0.3 + 0.7 * f.see[i] : 1; // 視点の選手に見えていない選手は薄く
    s += `<g opacity="${dim.toFixed(2)}"><circle cx="${x}" cy="${y}" r="1" fill="${COL[i < 11 ? 0 : 1]}" stroke="${rc}" stroke-width="${roles ? 0.4 : 0.2}"/>`
      + `<text x="${x}" y="${y}" dy="0.5" font-size="1.3" fill="#fff" text-anchor="middle" font-family="sans-serif">${(i % 11) + 1}</text>`;
    if (view) { // 体の向き（円の縁から出る短い線）
      const a = f.face[i], c = Math.cos(a), sn = Math.sin(a);
      s += `<line x1="${(+x + 1.05 * c).toFixed(2)}" y1="${(+y + 1.05 * sn).toFixed(2)}" x2="${(+x + 1.95 * c).toFixed(2)}" y2="${(+y + 1.95 * sn).toFixed(2)}" stroke="#fff" stroke-width="0.35" stroke-linecap="round"/>`;
    }
    s += '</g>';
  }
  const bx = f.ball[0].toFixed(2), by = f.ball[1].toFixed(2);
  s += `<circle cx="${bx}" cy="${by}" r="0.4" fill="#000" opacity="0.35"/>`
    + `<circle cx="${bx}" cy="${(f.ball[1] - f.ball[2] * 0.6).toFixed(2)}" r="0.55" fill="#fff" stroke="#111" stroke-width="0.12"/>`;
  return s;
}

export function sceneSvg(f) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VIEWBOX}" width="1050" height="680">${pitchSvg()}${actorsSvg(f)}</svg>`;
}

// 2つのコマの間を補間する（20Hzの試合を60fpsで滑らかに見せる）
export function lerpFrame(a, b, u) {
  const xy = new Float32Array(a.xy.length), ball = new Float32Array(3);
  for (let i = 0; i < xy.length; i++) xy[i] = a.xy[i] + (b.xy[i] - a.xy[i]) * u;
  for (let i = 0; i < 3; i++) ball[i] = a.ball[i] + (b.ball[i] - a.ball[i]) * u;
  let face = null;
  if (a.face && b.face) { // 向きは、角度の近いほうへ回して補間する
    face = new Float32Array(a.face.length);
    const T = 2 * Math.PI;
    for (let i = 0; i < face.length; i++) { const d = b.face[i] - a.face[i]; face[i] = a.face[i] + (d - T * Math.round(d / T)) * u; }
  }
  return { t: b.t, xy, ball, score: b.score, phase: b.phase, half: b.half, own: b.own, act: b.act, face, fov: b.fov, scn: b.scn, see: b.see, seeBy: b.seeBy };
}
