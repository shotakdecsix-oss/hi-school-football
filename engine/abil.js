// 選手の能力（32個）の並び。データ設計の ab 配列と同じ順。値は 1〜20（絶対評価）。
export const AB = {
  // 技術(10)
  PAS: 0, LNG: 1, TRP: 2, DRI: 3, SHT: 4, CRS: 5, HED: 6, TCK: 7, MRK: 8, SET: 9,
  // メンタル(10)
  DEC: 10, VIS: 11, OFF: 12, POS: 13, ANT: 14, CMP: 15, CON: 16, WRK: 17, AGG: 18, LDR: 19,
  // フィジカル(7)
  SPD: 20, ACC: 21, AGI: 22, STM: 23, STR: 24, JMP: 25, BAL: 26,
  // GK(5)
  GKR: 27, GKC: 28, GK1: 29, GKH: 30, GKD: 31,
};
export const NAB = 32;

// 入力の ab を 32個の配列にする。数値ならすべて同じ値（仮の総合力）、配列ならそのまま。
export function abVec(x) {
  const v = new Float64Array(NAB);
  if (typeof x === 'number') v.fill(x);
  else for (let k = 0; k < NAB; k++) v[k] = x[k];
  return v;
}
