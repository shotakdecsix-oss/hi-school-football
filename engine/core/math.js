// 決定的な数学関数
// ブラウザ・OS・CPUによって、Math の sin / cos / atan2 / exp / log / pow / hypot などは最後の桁が違うことがある。
// 試合は小さな差が積み重なって展開が変わるため、engine/ の中ではそれらを使わず、このファイルの関数を使う。
// 使ってよいのは四則演算と、結果が IEEE 754 で厳密に決まる sqrt / floor / ceil / round / trunc /
// abs / min / max / sign / imul / fround だけ。tools/test.js が違反を検査する。

export const PI = 3.141592653589793;
export const TAU = 6.283185307179586;
export const HALF_PI = 1.5707963267948966;
const HALF_PI_LO = 6.123233995736766e-17; // π/2 の倍精度表現との差
const TWO_OVER_PI = 0.6366197723675814;
const LN2_HI = 6.9314718036912381649e-1; // ln2 の上位（整数kを掛けても誤差が出ない形）
const LN2_LO = 1.90821492927058770002e-10;
const LOG2E = 1.4426950408889634;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const hypot = (x, y) => Math.sqrt(x * x + y * y);
export const wrapAngle = (a) => a - TAU * Math.floor((a + PI) / TAU); // [-π, π) に収める

// sin / cos の核（|r| <= π/4 で使う）
const S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880, S11 = -1 / 39916800, S13 = 1 / 6227020800, S15 = -1 / 1307674368000;
const C2 = -1 / 2, C4 = 1 / 24, C6 = -1 / 720, C8 = 1 / 40320, C10 = -1 / 3628800, C12 = 1 / 479001600, C14 = -1 / 87178291200, C16 = 1 / 20922789888000;
const sinK = (r) => {
  const q = r * r;
  return r * (1 + q * (S3 + q * (S5 + q * (S7 + q * (S9 + q * (S11 + q * (S13 + q * S15)))))));
};
const cosK = (r) => {
  const q = r * r;
  return 1 + q * (C2 + q * (C4 + q * (C6 + q * (C8 + q * (C10 + q * (C12 + q * (C14 + q * C16)))))));
};

export function sin(x) {
  const k = Math.round(x * TWO_OVER_PI);
  const r = (x - k * HALF_PI) - k * HALF_PI_LO;
  const q = k & 3;
  return q === 0 ? sinK(r) : q === 1 ? cosK(r) : q === 2 ? -sinK(r) : -cosK(r);
}

export function cos(x) {
  const k = Math.round(x * TWO_OVER_PI);
  const r = (x - k * HALF_PI) - k * HALF_PI_LO;
  const q = k & 3;
  return q === 0 ? cosK(r) : q === 1 ? -sinK(r) : q === 2 ? -cosK(r) : sinK(r);
}

export function atan(x) {
  const ax = x < 0 ? -x : x;
  let t = ax > 1 ? 1 / ax : ax;
  // 半角の公式 atan(t) = 2 atan(t / (1 + sqrt(1 + t²))) を3回使って t を小さくする
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));
  const q = t * t;
  let r = t * (1 + q * (-1 / 3 + q * (1 / 5 + q * (-1 / 7 + q * (1 / 9 + q * (-1 / 11 + q * (1 / 13 + q * (-1 / 15))))))));
  r *= 8;
  if (ax > 1) r = HALF_PI - r;
  return x < 0 ? -r : r;
}

export function atan2(y, x) {
  if (x === 0 && y === 0) return 0;
  if ((x < 0 ? -x : x) >= (y < 0 ? -y : y)) {
    const a = atan(y / x);
    return x > 0 ? a : y >= 0 ? a + PI : a - PI;
  }
  const a = atan(x / y);
  return y > 0 ? HALF_PI - a : -HALF_PI - a;
}

export const asin = (x) => atan2(x, Math.sqrt(Math.max(0, 1 - x * x)));
export const acos = (x) => atan2(Math.sqrt(Math.max(0, 1 - x * x)), x);

function pow2(k) {
  let b = 2, n = k, p = 1;
  if (k < 0) { b = 0.5; n = -k; }
  while (n > 0) {
    if (n & 1) p *= b;
    b *= b;
    n >>= 1;
  }
  return p;
}

export function exp(x) {
  if (!(x > -745)) return x === x ? 0 : x; // NaN はそのまま、とても小さい値は 0
  if (x > 709) return Infinity;
  const k = Math.round(x * LOG2E);
  const r = (x - k * LN2_HI) - k * LN2_LO; // |r| <= 0.35
  let p = 1;
  for (let n = 13; n >= 1; n--) p = 1 + (p * r) / n; // テイラー展開（ホーナー法）
  return p * pow2(k);
}

export function log(x) {
  if (!(x > 0)) return x === 0 ? -Infinity : NaN;
  if (x === Infinity) return Infinity;
  let m = x, e = 0;
  while (m >= 1.5) { m *= 0.5; e++; }
  while (m < 0.75) { m *= 2; e--; }
  const s = (m - 1) / (m + 1), s2 = s * s;
  let p = 0;
  for (let n = 10; n >= 0; n--) p = 1 / (2 * n + 1) + s2 * p; // ln(m) = 2s(1 + s²/3 + s⁴/5 + …)
  return e * LN2_HI + (e * LN2_LO + 2 * s * p);
}

export const pow = (x, y) => (x > 0 ? exp(y * log(x)) : y === 0 ? 1 : 0);
