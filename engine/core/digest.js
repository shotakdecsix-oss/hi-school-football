// 状態のチェック値（16桁の16進）。試合の再現性の確認と、保存した試合の再生時の照合に使う。
// 小数は 1/1024 単位に丸めてから混ぜる（-0 などの見かけの違いを吸収する。完全一致の検査には十分）。
import { mix32 } from './rng.js';

export class Digest {
  constructor() {
    this.a = 0x811c9dc5 | 0;
    this.b = 0x9e3779b9 | 0;
  }
  int(v) {
    v |= 0;
    this.a = Math.imul(this.a ^ v, 0x01000193);
    this.a ^= this.a >>> 15;
    this.b = Math.imul((this.b + v) | 0, 0x85ebca6b);
    this.b ^= this.b >>> 13;
    return this;
  }
  num(v) { return this.int(Number.isFinite(v) ? Math.round(v * 1024) : 0x7fc00000); }
  nums(arr) { for (let i = 0; i < arr.length; i++) this.num(arr[i]); return this; }
  ints(arr) { for (let i = 0; i < arr.length; i++) this.int(arr[i]); return this; }
  hex() {
    return mix32(this.a).toString(16).padStart(8, '0') + mix32(this.b ^ 0x5bd1e995).toString(16).padStart(8, '0');
  }
}
