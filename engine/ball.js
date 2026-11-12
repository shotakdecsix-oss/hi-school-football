// ボール物理（メートル・秒）。重力・空気抵抗・バウンド・転がり抵抗。ゴール／場外の判定もここで行う。
import { BALL_R, HL, HW, GOAL_HW, GOAL_H } from './consts.js';

const G = 9.80665; // 重力 (m/s²)
const C_AIR = 0.0135; // 空気抵抗の係数 (1/m)。加速度 = -C·|v|·v
const K_ROLL = 0.5; // 転がり抵抗 (1/s)。芝の上を20m/sで転がすと約40mで止まる
const E_BOUNCE = 0.6; // バウンドの反発
const SUB = 4; // 1tickを何分割して積分するか（高速のボールが選手をすり抜けないように）

// stepBall の戻り値
export const BALL_EV = { NONE: 0, GOAL_PX: 1, GOAL_NX: 2, OUT_PX: 3, OUT_NX: 4, OUT_PY: 5, OUT_NY: 6 };

// F[o..o+5] = x, y, z, vx, vy, vz を h 秒ぶん進める。ラインを越えたらそこで止めて種類を返す。
export function stepBall(F, o, h) {
  let x = F[o], y = F[o + 1], z = F[o + 2], vx = F[o + 3], vy = F[o + 4], vz = F[o + 5];
  const dt = h / SUB;
  let ev = BALL_EV.NONE;
  for (let s = 0; s < SUB; s++) {
    const x0 = x, y0 = y, z0 = z;
    if (z <= BALL_R + 1e-9 && vz <= 0) {
      // 地面を転がる
      const f = 1 - K_ROLL * dt;
      vx *= f; vy *= f; vz = 0; z = BALL_R;
      if (vx * vx + vy * vy < 0.0004) { vx = 0; vy = 0; }
    } else {
      // 空中
      const k = C_AIR * Math.sqrt(vx * vx + vy * vy + vz * vz);
      vx -= k * vx * dt;
      vy -= k * vy * dt;
      vz -= (G + k * vz) * dt;
    }
    x += vx * dt; y += vy * dt; z += vz * dt;
    if (z < BALL_R) {
      z = BALL_R;
      if (vz < 0) {
        vz = -vz * E_BOUNCE;
        if (vz < 0.8) vz = 0;
        vx *= 0.9; vy *= 0.9;
      }
    }
    if (x > HL || x < -HL) {
      // ゴールライン越え。ラインを通った地点の高さと横位置でゴールか場外かを決める
      const xe = x > 0 ? HL : -HL, u = (xe - x0) / (x - x0);
      const yc = y0 + (y - y0) * u, zc = z0 + (z - z0) * u;
      ev = yc > -GOAL_HW && yc < GOAL_HW && zc < GOAL_H
        ? (x > 0 ? BALL_EV.GOAL_PX : BALL_EV.GOAL_NX)
        : (x > 0 ? BALL_EV.OUT_PX : BALL_EV.OUT_NX);
      break;
    }
    if (y > HW || y < -HW) { ev = y > 0 ? BALL_EV.OUT_PY : BALL_EV.OUT_NY; break; }
  }
  F[o] = x; F[o + 1] = y; F[o + 2] = z; F[o + 3] = vx; F[o + 4] = vy; F[o + 5] = vz;
  return ev;
}
