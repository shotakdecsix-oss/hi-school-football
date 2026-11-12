// 乱数。順番に依存しない「座標ハッシュ型」を基本にする（用途と対象から値を作る）。
//   試合中:   hash4(試合の種, tick, 選手, 用途)  … 状態を持たないので、途中から再計算しても同じ値になる。
//   生成処理: Stream（順に引く型）。状態は4つの整数だけで、保存・復元できる。
// どちらも整数演算だけで作るので、端末が違っても同じ値になる。
import { log, cos, TAU } from './math.js';

const INV32 = 1 / 4294967296;

// 32bit の混ぜ関数（murmur3 の fmix32）
export function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// 4つの整数から 0〜2^32-1 の値を作る。同じ入力なら必ず同じ値。
export function hash4(a, b, c, d) {
  let h = mix32(((a | 0) + 0x9e3779b9) | 0);
  h = mix32(((h ^ (b | 0)) + 0x85ebca6b) | 0);
  h = mix32(((h ^ (c | 0)) + 0xc2b2ae35) | 0);
  h = mix32(((h ^ (d | 0)) + 0x27d4eb2f) | 0);
  return h;
}

export function hashStr(s) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

export const f4 = (a, b, c, d) => hash4(a, b, c, d) * INV32; // [0, 1)

function boxMuller(h1, h2) {
  const z = Math.sqrt(-2 * log((h1 + 0.5) * INV32)) * cos(TAU * (h2 * INV32));
  return z > 4 ? 4 : z < -4 ? -4 : z; // ±4 でカット
}

// 平均0・標準偏差1の正規乱数
export function normal4(a, b, c, d) {
  const h1 = hash4(a, b, c, d);
  return boxMuller(h1, mix32((h1 + 0x6d2b79f5) | 0));
}

// 順に引く乱数（sfc32）。選手や学校の生成など、引く順番が決まっている処理用。
export class Stream {
  constructor(seed, purpose = 0, target = 0) {
    const h = hash4(seed, purpose, target, 0x2545f491);
    this.s = new Int32Array([hash4(h, 1, 0, 0), hash4(h, 2, 0, 0), hash4(h, 3, 0, 0), 1]);
    for (let i = 0; i < 12; i++) this.u32();
  }
  u32() {
    const s = this.s;
    let a = s[0], b = s[1], c = s[2], d = s[3];
    const t = ((a + b) | 0) + d | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (((c << 21) | (c >>> 11)) + t) | 0;
    s[0] = a; s[1] = b; s[2] = c; s[3] = d;
    return t >>> 0;
  }
  float() { return this.u32() * INV32; }
  int(n) { return Math.floor(this.float() * n); }
  range(lo, hi) { return lo + (hi - lo) * this.float(); }
  chance(p) { return this.float() < p; }
  normal() { const a = this.u32(); return boxMuller(a, this.u32()); }
  pick(arr) { return arr[this.int(arr.length)]; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1), t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
  state() { return Array.from(this.s); }
  setState(a) { this.s.set(a); }
}
