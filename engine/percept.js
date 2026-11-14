// 認知（見える範囲）。選手ごとに「体の向き」と「気づき」を状態に持ち、周りの選手がどれだけ分かっているか（0〜1）を返す。
// 判断（保持者のパス・運ぶ・シュート）と守備（マークの相手の位置）が、この見え方を使う。
//
// - 体の向き（F_FACE）: 走っているときは進む向き、止まっているときはボールのほう。マークの選手はボールと相手の間。
//   向きは能力（敏捷性）で決まる速さでしか変えられない（背を向けて受けると、前を向くのに時間がかかる）。
// - 視野（コーン）: 向きの正面は確実に見える。端へ行くほど弱まり、背後は見えない。広さは能力「視野」で決まる。
//   ボールを持っている選手は、ボールを扱いながらなので扇が狭い（HOLD_FOV 倍）。
// - すぐそば（相手は6m・味方は10m）の選手は気配で分かる。ボールの位置は、常に全員が分かっている。
// - 味方の記憶（N_LS）: 視野ではっきり見た味方の位置は、しばらく覚えている（気づきが高いほど長く）。
//   パスの候補になれるのは、いま視野の中にいる味方と、少し前に見た味方だけ。見ていない味方には出さない。
//   再開（キックオフ・セットプレー）の最初のプレーは、周りを見渡せるので味方の全員が分かる。
// - 気づいていない相手（扇の外にいて、首を振って確認もしていない）に寄せられると、ボールを守れない（brain.js のタックル。blindOf）。
// - 気づき（F_SCN）: 首を振って周りを確認した度合い。見えていない相手の位置の把握（動きに気づく速さ・守備の危険の見積もり）と、
//   味方を覚えていられる長さに効く。自由な選手ほど上がる。ボールを持っている・ボールの近くで守っている・相手に寄せられているときは下がる。
// 入力 percept が 0 のときは、この層は何もしない（全員が全部見えている従来の動き。比較用）。省略したときは、この層を使う。
// 状態は F_FACE・F_SCN だけ。cos/sin の値（m.fcx, m.fcy）は毎tick作り直す作業用で、restore でも作り直す。
import { NP, DT, F_B, F_FACE, F_SCN, N_LS, I, ACT, PHASE } from './consts.js';
import { AB, NAB } from './abil.js';
import { atan2, cos, sin, wrapAngle, clamp, PI } from './core/math.js';

const D2R = PI / 180;
export const NEAR_T1 = 10; // 味方は、この距離（m）まで気配で分かる（声・足音）。相手は NEAR1
const NEAR0 = 1.5, NEAR1 = 6; // この距離（m）以内なら気配で分かる（NEAR0 以内は全部、NEAR1 を超えると 0）
const SCAN_COVER = 1; // 気づき 1 のときに、見えていない範囲をどれだけ把握しているか
const R_UP = 0.35, R_UPV = 0.05; // 気づきが上がる速さ（1秒あたり）= R_UP + R_UPV × (視野と判断力の平均)。負荷 0 のとき
const R_DN = 0.9; // 負荷 1（ボールに気を取られきっている）のときに下がる速さ（1秒あたり）
const OPP_FLOOR = 0.4; // 見えていない相手の、最低限の把握（判断で相手の危険を見積もるときの下限）
const MEM_T = 3; // 味方を視野で見てから、位置を覚えていられる時間の目安（秒。気づきが高いほど長い）
const SEEN_MIN = 0.5; // これ以上の見え方なら「はっきり見た」
const HOLD_FOV = 0.8; // ボールを持っている選手の視野の広さ（持っていないときに対する倍率）
const FOCUS_MARK = 0.8; // マークの選手がボールと相手の「間」を向くときの、相手の重み（ボール 1 に対して）

// 能力から決まる値（入力から決まる値。選手の入れ替えのたびに作り直す）
export function setLook(m, i) {
  const v = m.ab, A = i * NAB, vis = v[A + AB.VIS], dec = v[A + AB.DEC], agi = v[A + AB.AGI], ant = v[A + AB.ANT];
  const out = (70 + 3.5 * vis) * D2R; // これより外は見えない角度（正面から。視野10で105°）
  m.fov[i] = out;
  m.cOut[i] = cos(out);
  m.cIn[i] = cos(out - 30 * D2R); // この内側は確実に見える
  const oh = out * HOLD_FOV, ih = oh > 30 * D2R ? oh - 30 * D2R : 0; // ボールを持っているときの扇
  m.cOutH[i] = cos(oh);
  m.cInH[i] = cos(ih);
  m.wTurn[i] = (5 + 0.35 * agi) * DT; // 1 tick に向きを変えられる角度（rad）
  m.tLag[i] = clamp(0.5 - 0.015 * ant, 0.15, 0.5); // 見えていない相手の動きに気づくまでの遅れ（秒）
  m.rScan[i] = R_UP + R_UPV * (vis + dec) / 2;
}

// 向きの cos/sin を状態から作り直す（毎tickと、restore のあと）
export function refreshFace(m) {
  for (let i = 0; i < NP; i++) {
    const a = m.F[F_FACE + i];
    m.fcx[i] = cos(a); m.fcy[i] = sin(a);
  }
}

// キックオフ（試合の最初・得点のあと・後半の始まり）: 全員がボール（センターサークル）のほうを向く
export function initLook(m) {
  const { F, px, py } = m;
  for (let i = 0; i < NP; i++) {
    F[F_FACE + i] = atan2(F[F_B + 1] - py[i], F[F_B] - px[i]);
    F[F_SCN + i] = 0.6;
    for (let j = k0(i); j < k0(i) + 11; j++) m.N[N_LS + i * NP + j] = m.t; // キックオフのときは、味方の配置を全員が分かっている
  }
  refreshFace(m);
}
const k0 = (i) => (i < 11 ? 0 : 11);

// 点 (x, y)（地面の位置）を、選手 i がどれだけ見ているか（0〜1）。向き・視野・すぐそば の最大（気づきは含めない）
export function seeAt(m, i, x, y, n1 = NEAR1) {
  const dx = x - m.px[i], dy = y - m.py[i], d2 = dx * dx + dy * dy;
  if (d2 < 0.36) return 1;
  const d = Math.sqrt(d2), c = (dx * m.fcx[i] + dy * m.fcy[i]) / d, h = m.N[I.OWN] === i;
  const co = h ? m.cOutH[i] : m.cOut[i];
  let w = (c - co) / ((h ? m.cInH[i] : m.cIn[i]) - co);
  w = w < 0 ? 0 : w > 1 ? 1 : w;
  let nw = (n1 - d) / (n1 - NEAR0);
  nw = nw < 0 ? 0 : nw > 1 ? 1 : nw;
  return w > nw ? w : nw;
}

// 点 (x, y) が、選手 i の視野の扇の中にどれだけ入っているか（0〜1）。すぐそばの気配は含めない
export function coneAt(m, i, x, y) {
  const dx = x - m.px[i], dy = y - m.py[i], d2 = dx * dx + dy * dy;
  if (d2 < 1e-6) return 1;
  const c = (dx * m.fcx[i] + dy * m.fcy[i]) / Math.sqrt(d2), h = m.N[I.OWN] === i;
  const co = h ? m.cOutH[i] : m.cOut[i];
  const w = (c - co) / ((h ? m.cInH[i] : m.cIn[i]) - co);
  return w < 0 ? 0 : w > 1 ? 1 : w;
}

// ボールを持っている選手 o が、相手 j に気づいていない度合い（0〜1）。扇の外から寄せられても、首を振って確認していれば（気づき）備えられる
export function blindOf(m, o, j) {
  const c = coneAt(m, o, m.px[j], m.py[j]), s = m.F[F_SCN + o];
  return 1 - (c > s ? c : s);
}

// 選手 i の視野の半角（rad）。ボールを持っているときは狭い（表示用）
export function fovOf(m, i) { return m.N[I.OWN] === i ? m.fov[i] * HOLD_FOV : m.fov[i]; }

// 点 (x, y) を、視野に加えて「気づき」（首を振って確認した分。見えていない範囲も少しは分かっている）まで含めて、どれだけ把握しているか（0〜1）。相手の位置の把握に使う
export function senseAt(m, i, x, y) {
  const v = seeAt(m, i, x, y), s = m.F[F_SCN + i] * SCAN_COVER;
  return v > s ? v : s;
}

// 味方 j の位置を、選手 i がどれだけ覚えているか（0〜1）。視野ではっきり見た時刻から、時間とともに薄れる（気づきが高いほど長く覚えている）
export function memOf(m, i, j) {
  const T = MEM_T * (0.3 + 0.7 * m.F[F_SCN + i]);
  const age = (m.t - m.N[N_LS + i * NP + j]) * DT;
  return age >= T ? 0 : 1 - age / T;
}

// 選手 i から見た全員の見えている度合いを m.aw に入れて返す（自分は 1）。判断のたびに作り直す作業用
// full: 再開の前など、周りを見渡す時間があるとき（味方は全員分かっている）
export function seeAll(m, i, full) {
  const aw = m.aw, { px, py, team } = m, k = team[i];
  for (let j = 0; j < NP; j++) {
    if (j === i) { aw[j] = 1; continue; }
    if (team[j] === k) { // 味方: 視野の中か、少し前に見た味方だけ
      if (full) { aw[j] = 1; continue; }
      const v = seeAt(m, i, px[j], py[j], NEAR_T1), e = memOf(m, i, j);
      aw[j] = v > e ? v : e;
    } else aw[j] = OPP_FLOOR + (1 - OPP_FLOOR) * senseAt(m, i, px[j], py[j]); // 見えていない相手も、全く分からないわけではない（気配・音・チームの動きから）
  }
  return aw;
}

// 選手 i が相手 j の動きに気づくまでの遅れ（秒）。見えていれば 0、見えていないほど長い
export function lagOf(m, i, j) {
  return m.tLag[i] * m.mkL[i] * m.ofL[j] * (1 - senseAt(m, i, m.px[j], m.py[j])); // マークが上手いほど見失いにくく、相手の動き出しが上手いほど見失いやすい
}

// 選手 i の周りの相手の圧力（decide.js の pressureAt と同じ式。循環 import を避けて持つ）
function pressOf(m, i) {
  const { px, py } = m, j0 = (1 - m.team[i]) * 11;
  let p = 0;
  for (let j = j0; j < j0 + 11; j++) {
    const dx = px[j] - px[i], dy = py[j] - py[i], d2 = dx * dx + dy * dy;
    if (d2 < 36) p += 1 - Math.sqrt(d2) / 6;
  }
  return p > 1.5 ? 1.5 : p;
}

// 1 tick ぶん、全員の向きと気づきを更新する（移動のあとに呼ぶ）
export function look(m) {
  const { F, N, px, py, vx, vy, team, act, tgt, fcx, fcy, wTurn, rScan } = m;
  const bx = F[F_B], by = F[F_B + 1], own = N[I.OWN], poss = N[I.POSS];
  for (let i = 0; i < NP; i++) {
    const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
    const bdx = bx - px[i], bdy = by - py[i], bd = Math.sqrt(bdx * bdx + bdy * bdy);
    // 1. 向きたい方向: 基本はボールのほう。保持者は運ぶ先。マークの選手はボールと相手の間。速く動いているときは進む向き
    let ux = fcx[i], uy = fcy[i];
    if (i === own) {
      const ex = m.tx[i] - px[i], ey = m.ty[i] - py[i], ed = Math.sqrt(ex * ex + ey * ey);
      if (ed > 1) { ux = ex / ed; uy = ey / ed; }
    } else if (bd > 0.3) {
      ux = bdx / bd; uy = bdy / bd;
      if (act[i] === ACT.MARK && tgt[i] >= 0) {
        const q = tgt[i], mx = px[q] - px[i], my = py[q] - py[i], md = Math.sqrt(mx * mx + my * my);
        if (md > 0.3) {
          const sx = ux + FOCUS_MARK * mx / md, sy = uy + FOCUS_MARK * my / md, sl = Math.sqrt(sx * sx + sy * sy);
          if (sl > 0.5) { ux = sx / sl; uy = sy / sl; } // ボールと相手が正反対に近いときは、ボールのほうを向く
        }
      }
    }
    if (sp > 1.5) {
      const b = clamp((sp - 1.5) / 3, 0, 1);
      ux = ux * (1 - b) + (vx[i] / sp) * b; uy = uy * (1 - b) + (vy[i] / sp) * b;
    }
    // 2. 向きを変える（1 tick に wTurn まで）
    if (ux * ux + uy * uy > 1e-6) {
      const d = wrapAngle(atan2(uy, ux) - F[F_FACE + i]), w = wTurn[i];
      F[F_FACE + i] = wrapAngle(F[F_FACE + i] + (d < -w ? -w : d > w ? w : d));
    }
    // 3. 気づき: 負荷（ボールや相手に気を取られている度合い）に向かって、時間をかけて上がる・下がる
    const press = pressOf(m, i);
    let L;
    if (i === own) L = 0.2 + 0.5 * (press > 1 ? 1 : press); // ボールを持っている間は、足元に気が行く
    else {
      const lb = team[i] === poss ? 0 : 0.95 * clamp(1 - bd / 32, 0, 1); // 相手がボールを持っているとき、ボールの近くの守備は目が離せない
      const lp = 0.7 * (press > 1.5 ? 1 : press / 1.5); // 寄せられている
      L = lb > lp ? lb : lp;
    }
    const up = rScan[i] * (1 - L), dn = R_DN * L;
    const s = F[F_SCN + i] + DT * (up - (up + dn) * F[F_SCN + i]);
    F[F_SCN + i] = s < 0 ? 0 : s > 1 ? 1 : s;
  }
  refreshFace(m);
  // 味方を視野ではっきり見ていたら、その tick を覚える
  for (let i = 0; i < NP; i++) {
    const a = k0(i);
    for (let j = a; j < a + 11; j++) if (j !== i && seeAt(m, i, px[j], py[j], NEAR_T1) >= SEEN_MIN) N[N_LS + i * NP + j] = m.t;
  }
}
