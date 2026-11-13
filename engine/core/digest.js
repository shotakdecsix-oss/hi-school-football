// 状態のチェック値（16桁の16進）。試合の再現性の確認と、保存した試合の再生時の照合に使う。
// 小数は64ビットの全ビットを混ぜる（v14から。丸めると、端末による小さなずれが途中で見えなかった）。-0 は 0、NaN は1種類にそろえる。
// 並べ方は端末の並び（エンディアン）に依らないよう、下位32ビット→上位32ビットの順に固定する。
import { mix32 } from './rng.js';

const DV = new DataView(new ArrayBuffer(8));

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
  num(v) {
    if (v !== v) return this.int(0x7ff80000).int(0); // NaN
    DV.setFloat64(0, v === 0 ? 0 : v, true); // -0 は 0
    return this.int(DV.getUint32(0, true)).int(DV.getUint32(4, true));
  }
  nums(arr) { for (let i = 0; i < arr.length; i++) this.num(arr[i]); return this; }
  ints(arr) { for (let i = 0; i < arr.length; i++) this.int(arr[i]); return this; }
  hex() {
    return mix32(this.a).toString(16).padStart(8, '0') + mix32(this.b ^ 0x5bd1e995).toString(16).padStart(8, '0');
  }
}
