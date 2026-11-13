// ボールに触れた選手の記録（得点者とアシストの判定用）。
// 触れたとき（キック・コントロール・タックル・GKのはじき・ファーストタッチの乱れ）に markTouch を呼ぶ。
// チームごとに、最後に触れた選手（T1）とその tick、その直前に触れた同じチームの別の選手（T2。間に相手が触れていたら -1）とその tick を持つ。
import { I } from './consts.js';

// 選手 p が tick t にボールに触れた
export function markTouch(m, p, t) {
  const { N, team } = m, k = team[p], o = 1 - k;
  N[I.LAST] = p;
  const broken = N[I.T1T + o] > N[I.T1T + k]; // 前に触れてから、相手が触れた
  if (N[I.T1 + k] !== p) {
    if (broken) N[I.T2 + k] = -1;
    else { N[I.T2 + k] = N[I.T1 + k]; N[I.T2T + k] = N[I.T1T + k]; }
    N[I.T1 + k] = p;
  } else if (broken) N[I.T2 + k] = -1;
  N[I.T1T + k] = t;
}

// ゴールの記録 [得点者, アシスト, オウンゴール(0/1)]。k = 得点したチーム、t = ゴールの tick。
// 得点者は、その側で最後にボールに触れた選手。最後に触れたのが守る側の選手（GKのはじき・ディフレクション）でも、
// その側の最後の接触が3秒以内なら、その選手の得点。それより前なら、最後に触れた守る側の選手のオウンゴール。
// アシストは、得点者の直前に触れた同じチームの別の選手（間に相手が触れていない）で、その接触が10秒以内のとき。
export const DEFLECT_T = 60, ASSIST_T = 200; // 3秒・10秒（tick）
export function goalCredit(m, k, t) {
  const { N, team } = m, last = N[I.LAST];
  const lastK = last >= 0 ? team[last] : -1;
  let scorer = last, og = 0;
  if (lastK !== k) {
    if (N[I.T1 + k] >= 0 && t - N[I.T1T + k] <= DEFLECT_T) scorer = N[I.T1 + k];
    else og = last >= 0 ? 1 : 0;
  }
  const a = N[I.T2 + k];
  const assist = !og && scorer === N[I.T1 + k] && a >= 0 && t - N[I.T2T + k] <= ASSIST_T ? a : -1;
  return [scorer, assist, og];
}
