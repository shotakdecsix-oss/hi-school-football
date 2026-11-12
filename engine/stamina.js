// スタミナ（体力）。選手ごとに 1（万全）〜 0。状態は F_STA に持つ（保存・復元できる）。
// 走ると減り（高い強度ほど急に減る）、ゆっくり動いていると少しずつ回復する。減るほど最高速度・加速度が落ちる。
// 減り方の目安: 標準の試合で、STM 10 の外野手が80分の終わりに 0.6 前後。強く寄せる・走り回るチームほど低くなる。
import { NP, DT, F_STA } from './consts.js';

const KD = 0.0045, KR = 2e-4, X_REC = 0.3; // 消耗・回復の速さ（1秒あたり）。回復は最高速度の 3割より遅いときだけ
export const HALF_REC = 0.15; // ハーフタイム（延長前の休憩）での回復量

// 強度 x（今の速さ ÷ 本来の最高速度）で 1秒に使う量（相対）。高速に走るほど急に増える。
const cost = (x) => { const h = x - 0.6; return 0.15 * x * x * x + (h > 0 ? 9 * h * h : 0); };
// 能力 STM から決まる、消耗の速さと回復の速さの倍率（STM 10 で 1）
export const drainK = (stm) => 1.5 / (1 + 0.05 * stm);
export const recoverK = (stm) => 0.7 + 0.03 * stm;
// 疲れによる最高速度・加速度の倍率（スタミナ 1 で 1。減るほど、とくに低いところで急に落ちる）
const speedK = (s) => { const d = 1 - s; return 1 - 0.35 * d * Math.sqrt(d); };
const accK = (s) => 1 - 0.4 * (1 - s);

// 選手 i の最高速度・加速度を、いまのスタミナから作り直す（m.vmax0 / m.acc0 は能力から決まる本来の値）
export function fatigue(m, i) {
  const s = m.F[F_STA + i];
  m.vmax[i] = m.vmax0[i] * speedK(s);
  m.acc[i] = m.acc0[i] * accK(s);
}

// 1 tick ぶん、全員のスタミナを更新する
export function tire(m) {
  const { F, vx, vy, vmax0, sdr, srec } = m;
  for (let i = 0; i < NP; i++) {
    const x = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]) / vmax0[i];
    let s = F[F_STA + i] + DT * (KR * srec[i] * (x < X_REC ? 1 - x / X_REC : 0) - KD * sdr[i] * cost(x));
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    F[F_STA + i] = s;
    fatigue(m, i);
  }
}

// ハーフタイムなどの休憩で、全員が少し回復する
export function rest(m) {
  for (let i = 0; i < NP; i++) {
    const s = m.F[F_STA + i] + HALF_REC;
    m.F[F_STA + i] = s > 1 ? 1 : s;
    fatigue(m, i);
  }
}

// チーム k の外野手のスタミナの平均（表示・集計用）
export function staminaOf(m, k) {
  let a = 0;
  for (let s = 1; s < 11; s++) a += m.F[F_STA + k * 11 + s];
  return a / 10;
}

