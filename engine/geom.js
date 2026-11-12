// 幾何と「価値」の関数（純粋関数）。fx, fy は攻める向きを +x に揃えた座標。
import { HL, GOAL_HW, BALL_R } from './consts.js';
import { atan2, log } from './core/math.js';

const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const K_ROLL = 0.5; // ball.js の転がり抵抗と同じ
export const R_CTRL = 0.8; // 足元のボールに触れられる距離 (m)
export const REACT_BASE = 0.4; // ボールの動きを見て動き出すまでの基本の遅れ (秒)。反応(ANT)が低いと +0.02秒/点

// 静止状態から距離 d を走りきる時間（加速度 acc、最高速度 vmax）
export function timeToCover(d, vmax, acc) {
  if (d <= 0) return 0;
  return d <= (vmax * vmax) / (2 * acc) ? Math.sqrt((2 * d) / acc) : d / vmax + vmax / (2 * acc);
}

// ボールを持つ価値（その位置から最終的に得点に結びつく見込みの目安）。敵ゴールに近く、中央ほど高い。
export function xt(fx, fy) {
  const s = c01((fx + HL) / (2 * HL)), s2 = s * s, s4 = s2 * s2;
  const c = c01(1 - Math.abs(fy) / 30);
  return (0.004 + 0.045 * s2 + 0.35 * s4 * s4) * (0.5 + 0.5 * c);
}

// シュートが決まる見込み（プロの水準）。ゴールの両ポストを見込む角 θ から 0.28θ²。
// dx: ゴールラインまでの距離、dy: ゴール中央からの横ずれ
export function xgAt(dx, dy) {
  if (dx < 0.5) dx = 0.5;
  const th = Math.abs(atan2(GOAL_HW - dy, dx) - atan2(-GOAL_HW - dy, dx));
  return 0.28 * th * th;
}

// 地面のパス: 着く時の速さ vA を決めると、初速は vA + K・距離（転がり抵抗の分）。かかる時間は ln(v0/vA)/K。
const arrive = (D) => (D < 4 ? 8.5 : D > 32 ? 13 : 8.5 + 0.15 * D);
export function passV0(D) { return arrive(D) + K_ROLL * D; }
export function groundPass(D) {
  const vA = arrive(D), v0 = vA + K_ROLL * D;
  return { v0, vA, T: log(v0 / vA) / K_ROLL };
}

// 浮き球: 打ち出し角を固定して、狙いの距離 D に着地する初速を二分法で求める（空気抵抗つきの簡易シミュレーション）。
const CA = 0.8139, SA = 0.581; // 打ち出し角 約35.5°
let LT = 0;
function lobRange(v) {
  let x = 0, z = BALL_R, vx = v * CA, vz = v * SA, t = 0;
  const h = 0.05;
  for (let s = 0; s < 160; s++) {
    const k = 0.0135 * Math.sqrt(vx * vx + vz * vz);
    vx -= k * vx * h; vz -= (9.80665 + k * vz) * h;
    x += vx * h; z += vz * h; t += h;
    if (z <= BALL_R && vz < 0) break;
  }
  LT = t;
  return x;
}
export function lobPlan(D) {
  let lo = 8, hi = 45;
  for (let n = 0; n < 12; n++) { const mid = 0.5 * (lo + hi); if (lobRange(mid) < D) lo = mid; else hi = mid; }
  const v = 0.5 * (lo + hi);
  lobRange(v);
  return { vh: v * CA, vz: v * SA, T: LT }; // vh = 水平方向の初速
}
