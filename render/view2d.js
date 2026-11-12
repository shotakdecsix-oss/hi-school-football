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

// 役割（ACT の番号順）ごとの輪の色。0=持ち場 1=保持 2=プレス 3=カバー 4=マーク 5=サポート 6=裏抜け 7=受ける 8=関わり続ける 9=ボールを追う
export const ROLE_COL = ['#ffffff', '#ffe600', '#ff7800', '#ffaa3c', '#b45cf0', '#28d25e', '#00e0e0', '#ff40d0', '#9be29b', '#ff5050'];
export const ROLE_LEGEND = '輪の色: 黄=保持 橙=プレス/カバー 紫=マーク 緑=サポート 水=裏抜け 桃=受ける 赤=追う 白=持ち場';

export function actorsSvg(f, roles = false) {
  let s = '';
  for (let i = 0; i < 22; i++) {
    const x = f.xy[2 * i].toFixed(2), y = f.xy[2 * i + 1].toFixed(2), gk = i % 11 === 0;
    const rc = roles && f.act ? ROLE_COL[f.act[i]] || '#fff' : gk ? '#ffd60a' : '#fff';
    if (f.own === i) s += `<circle cx="${x}" cy="${y}" r="2" fill="none" stroke="#ffe600" stroke-width="0.35" opacity="0.9"/>`;
    s += `<circle cx="${x}" cy="${y}" r="1" fill="${COL[i < 11 ? 0 : 1]}" stroke="${rc}" stroke-width="${roles ? 0.4 : 0.2}"/>`
      + `<text x="${x}" y="${y}" dy="0.5" font-size="1.3" fill="#fff" text-anchor="middle" font-family="sans-serif">${(i % 11) + 1}</text>`;
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
  return { t: b.t, xy, ball, score: b.score, phase: b.phase, half: b.half, own: b.own, act: b.act };
}
