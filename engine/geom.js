// 幾何と「価値」の関数（純粋関数）。fx, fy は攻める向きを +x に揃えた座標。
import { HL, HW, GOAL_HW, BALL_R } from './consts.js';
import { atan2, log } from './core/math.js';

const c01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// ファーストタッチの出来の目安（大きいほど良い。σ=2.5 のばらつきが乗って、負ならタッチが乱れる）。
// brain.js の onTouch（実際の接触）と decide.js のパスの見積もりが、同じ式を使う。
// 圧力が強いほど指数的に悪化する（圧力1.5で 10*1.5+3*2.25=21.8 → 密集の中でのパスはほぼ止められない）。
export const TOUCH_P1 = 10, TOUCH_P2 = 3;
// pass=false はこぼれ球（パスではない自由なボール）。奪い合いなので、圧力の影響は小さい（ボールを弾き合い続けない）。
export const touchMean = (trp, cmp, vb, press, pass = true, pq = 0) => 3 + 0.8 * trp + 0.2 * cmp - 0.3 * vb + pq - (pass ? TOUCH_P1 * press + TOUCH_P2 * press * press : 5 * press); // pq: 蹴った人のパスの質（足元へ・止めやすい強さと回転。PAS・LNG が基準より高いほど +）
export const K_PQ = 0.5, K_LQ = 0.4; // パスの質の効き（1点あたり）: 地面のパス（PAS）・浮き球（LNG。GK は GKD）
export const K_RD = 0.1, K_MKL = 0.06, K_OFL = 0.08, K_WRK = 0.05, K_SEP = 0.08, K_CT = 0.4, K_CS = 0.03; // 動き出し（OFF）1点あたりの、パスを受けるときの圧力の減り・集中力（CON）1点あたりのファーストタッチの加点とパスの誤差の減り（疲れているほど効く） // 読み（POS・MRK）1点あたりのボールに届く範囲の増え・マークの見失いの減り・相手の動き出し（OFF）1点あたりの見失いの増え・運動量（WRK）1点あたりの寄せる走りの強さ
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
  // ゴール前の高い価値は「ゴールが見える角度」に比例させる（中央=1、脇やゴールライン際は小さい）。
  // 角度の近似: D2/(D2+fy²)、D2 = ゴールまでの距離² + 12。ゴールライン際を運んで回っても価値が高いままだと、撃たずにパスや運びを選び続けてしまう。
  const dg = HL - fx, D2 = (dg > 0 ? dg * dg : 0) + 12;
  return (0.004 + 0.045 * s2) * (0.5 + 0.5 * c) + 0.35 * s4 * s4 * (D2 / (D2 + fy * fy));
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
// 点 (x,y) から単位ベクトル (ux,uy) の向きに、ラインの0.5m内側までフィールド内を進める距離
export function rollRoom(x, y, ux, uy) {
  let s = 1e9, s2 = 1e9;
  if (ux > 1e-6) s = (HL - 0.5 - x) / ux; else if (ux < -1e-6) s = (-HL + 0.5 - x) / ux;
  if (uy > 1e-6) s2 = (HW - 0.5 - y) / uy; else if (uy < -1e-6) s2 = (-HW + 0.5 - y) / uy;
  if (s2 < s) s = s2;
  return s > 0 ? s : 0;
}
// room: 狙い点のさきでボールが転がれる距離。着く速さは「止まるまでにラインを割らない」強さ(K_ROLL×room)までに抑える（下限 2.5m/s）
export function groundPass(D, room = 1e9) {
  const vA = Math.min(arrive(D), Math.max(2.5, K_ROLL * room)), v0 = vA + K_ROLL * D;
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
