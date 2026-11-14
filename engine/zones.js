// ゾーン配置（v21）: data/zones.js の升の表を、エンジンが使う数値（領域の中心・範囲）にする。入力から決まる値（状態ではない）。
// 升は 5レーン × 10行（1行 10.5m・1レーン 13.6m）。領域 = 選手の升の集まりの外側の四角、中心 = 升の中心の平均。
import { ZONES } from '../data/zones.js';
import { HL, HW } from './consts.js';

export const ZR = 2 * HL / 10, ZL = 2 * HW / 5; // 升の大きさ（奥行 10.5m・横 13.6m）
export const ZK = 35; // 局面のキーフレーム: ボールが自チームの向きで -ZK / 0 / +ZK にあるとき、自陣1/3・中盤・敵陣1/3の局面そのもの（間は直線で混ぜる）
export const ZC = 6; // 1人1局面の数値の数: [中心の奥行, 中心の横, 奥行の下限, 上限, 横の下限, 上限]（奥行は自陣ゴールライン=-HL から +HL、横は選手の向きでの横）
const LANES = 'abcde';

// '2b 3b' → [中心f, 中心g, f0, f1, g0, g1]
function region(str) {
  let sf = 0, sg = 0, n = 0, f0 = 1e9, f1 = -1e9, g0 = 1e9, g1 = -1e9;
  for (const c of str.trim().split(/\s+/)) {
    const r = c.charCodeAt(0) - 48, l = LANES.indexOf(c[1]);
    if (!(r >= 0 && r < 10 && l >= 0 && c.length === 2)) throw new Error('升の書き方が違います: ' + c);
    const a = -HL + r * ZR, b = a + ZR, p = -HW + l * ZL, q = p + ZL;
    sf += (a + b) / 2; sg += (p + q) / 2; n++;
    if (a < f0) f0 = a; if (b > f1) f1 = b; if (p < g0) g0 = p; if (q > g1) g1 = q;
  }
  return [sf / n, sg / n, f0, f1, g0, g1];
}

// 陣形 name の領域の表。Float64Array[((side×3 + q)×10 + (s−1)) × ZC + c]。side 0=攻撃・1=守備、q 0..2 = ボールが低い（自陣側）→ 中間 → 高い（敵陣側）の順
// （data/zones.js の守備は「相手のビルドアップ（ボールが高い）」から書いてあるので、ここで逆にする）。表のない陣形は null（従来の持ち場の式を使う）
export function buildZones(name) {
  const Z = ZONES[name];
  if (!Z) return null;
  const out = new Float64Array(2 * 3 * 10 * ZC);
  for (let side = 0; side < 2; side++) {
    const T = side === 0 ? Z.att : Z.def;
    if (!T || T.length !== 3) throw new Error('局面は3つ必要です: ' + name);
    for (let q = 0; q < 3; q++) {
      const row = T[side === 0 ? q : 2 - q];
      if (row.length !== 10) throw new Error('スロットは10人分必要です: ' + name);
      for (let s = 0; s < 10; s++) out.set(region(row[s]), ((side * 3 + q) * 10 + s) * ZC);
    }
  }
  return out;
}

// ボールの位置 sfx（自チームの向きで m）から、3つの局面の混ぜ具合 w[0..2]（低い・中間・高い）
export function phaseW(sfx, w) {
  const t = sfx < -ZK ? -1 : sfx > ZK ? 1 : sfx / ZK;
  w[0] = t < 0 ? -t : 0; w[2] = t > 0 ? t : 0; w[1] = 1 - (t < 0 ? -t : t);
}
