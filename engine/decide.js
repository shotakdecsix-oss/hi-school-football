// 保持者の判断と実行（4層AIの「判断」と「実行」）。
// 選択肢（シュート・パス・スペースへのパス・ドリブル・クリア）に点数をつけ、一番高いものを選ぶ。
// 点数 = ボールを持つ価値(xt)の期待値。乱数は「見え方（点数の誤差）」と「蹴りの誤差」にだけ使う。
import { HL, HW, GOAL_HW, GOAL_H, BALL_R, F_B, F_PASS, I, ACT, EV, ST, ST_N, SP, PHASE, dirOf } from './consts.js';
import { AB, NAB } from './abil.js';
import { ROLE } from '../data/formations.js';
import { normal4, f4 } from './core/rng.js';
import { atan2, cos, sin, log, exp, clamp } from './core/math.js';
import { xt, xgAt, groundPass, lobPlan, rollRoom, timeToCover, touchMean, K_ROLL, R_CTRL, REACT_BASE } from './geom.js';
import { seeAll } from './percept.js';

const LOSS_W = 0.75; // ボールを失ったとき、相手がそこから得る価値の重み
const KEEP = 0.008; // ボールを持ち続けること自体の価値（失うと同じ分を失う）
const K_DRIB = 0.85, K_PASS = 1.0; // 調整用の倍率（一括実行の数値を見て合わせる）
// シュートの価値の倍率: 位置と能力だけの見込み(xG)が低いほど控えめ(SHOT_LO)、高いほど積極的(SHOT_HI)。撃てる位置ほど撃つ意識が強く、遠いシュートは控えめ
const SHOT_LO = 0.3, SHOT_HI = 1.05, SHOT_X0 = 0.03, SHOT_XW = 0.07;
// ゴール前の価値の整合。撃つ見込みは「コースに立つ相手（1人ごとに BLK 倍）× 圧力（PRS_S）」で割り引く（強制シュートの実測に合わせた）。
// パスの行き先・運ぶ先の「ボールを持つ価値(xt)」も、同じ式で見積もった「そこで撃てる見込み」の CONT 倍を上限にする。
// 上限が効くのはゴールから ZN m 以内（ZN-ZW m 以内で全面的に）。これが無いと、ゴール前で撃てる場面でも、後ろの味方へのパスや運ぶほうが得に見えて撃たなくなる。
// （ZN を広げると、ボックスの手前でつなぎ続けて撃たなくなる・遠くから撃つ本数が増える副作用が出るので、ゴール前だけにしている）
const BLK = 0.75, PRS_S = 0.3, ZN = 15, ZW = 6, CONT = 1.0;
const WIN_K = 0.5; // 奪った直後の窓での、前へ進める価値・リスクの重みの変え方（指示 ±1 で ±50%）
const K_PRS = 0.5; // 行き先の圧力による価値の割引（圧力1.5で 1-1.5*K_PRS）。人でごった返すゴール前へ突っ込まない
const prsF = (pd) => { const f = 1 - K_PRS * (pd > 1.5 ? 1.5 : pd); return f > 0.25 ? f : 0.25; };

// 攻め方（中央から ←→ サイドから）: 行き先の価値を、横位置で増減する倍率。敵陣のほうが強く効く。指示が 0 なら 1
export function latM(ap, dfx, dfy) {
  if (ap.latK === 0) return 1;
  const w = clamp((dfx - 5) / 25, 0, 1), a = (Math.abs(dfy) - 17) / 17;
  return 1 + ap.latK * w * (a < -1 ? -1 : a > 1 ? 1 : a);
}

// 点 (fx,fy)（攻める向きを+にした座標）から撃ったときの見込み（得点の確率の目安）。
// 位置の見込み(xG) × シュート能力の補正 shtF × コースに立つ相手（GK以外）× 圧力
function shotQ(m, k, dir, fx, fy, press, shtF) {
  const { px, py } = m, o0 = (1 - k) * 11, dgx = HL - fx;
  let block = 1;
  for (let q = o0 + 1; q < o0 + 11; q++) {
    const qf = px[q] * dir, qy = py[q] * dir;
    if (qf > fx && qf < HL) {
      const ly = fy * (1 - (qf - fx) / dgx);
      if (Math.abs(qy - ly) < 2.2) block *= BLK;
    }
  }
  return xgAt(dgx, fy) * block * shtF * (1 - PRS_S * press);
}

// ゴール前の「ボールを持つ価値」v（xt から作った値）に、そこで撃てる見込みの CONT 倍を上限にかける。遠い所は v のまま。
function zoneCap(m, k, dir, dfx, dfy, pd, v, shtF) {
  const dgx = HL - dfx;
  if (dgx >= ZN) return v;
  const cap = CONT * shotQ(m, k, dir, dfx, dfy, pd, shtF);
  if (cap >= v) return v;
  return v + (dgx <= ZN - ZW ? 1 : (ZN - dgx) / ZW) * (cap - v);
}
// 運ぶ（ドリブル）の候補: ゴールへ向かう向きを前として、前・斜め前・横・斜め後ろの7方向 × 近く(4.5m)と遠く(9m)
const CD = [[1, 0], [0.7071, 0.7071], [0.7071, -0.7071], [0, 1], [0, -1], [-0.7071, 0.7071], [-0.7071, -0.7071]];
const CL = [4.5, 9];
const RELIEF = 0.016; // 相手の圧力が減る場所へ運ぶ価値（圧力1あたり）
const MOM = 0.005; // 今の走る向きを続ける価値（急に向きを変える・止まるのは時間を失う）
const CARRY_COST = 0.002, CARRY_M = 0.0; // 運ぶ手間（ボールが足元から離れる。距離にも比例）
const HOLD_W = 0.006; // 持ち続けて hold0（指示 テンポ。標準 1.5）秒を過ぎると、1秒ごとに HOLD_W ずつ運ぶ価値が下がる（味方を探してパスする）

// ドリブルのタッチミス（ボールが足元から離れて奪い合いになる）の起こりやすさ（1秒あたり）。
// 速く走るほど・圧力が強いほど・ドリブルが下手なほど起こる。brain.js の carryBall が実際に起こし、判断（運ぶ価値）も同じ式で見積もる。
export function touchHazard(sp, press, dri, bal) {
  const r = sp * 0.125;
  return (0.02 + 0.10 * r * r) * (1 + 0.8 * (press > 1 ? 1 : press)) * (1.3 - 0.025 * dri - 0.005 * bal);
}

// 奪った直後の窓（指示 onWin。奪ってから winW tick の間）なら、その指示の値（-1〜+1）を返す。窓の外・指示なしは 0（標準）。
// 縦に速く(+)は、リスクを取って前へ進める価値を上げ、キープ(-)は、失う危険を重く見て落ち着く。
export function winMode(m, k) {
  const c = m.tac[k];
  return c.winW > 0 && m.N[I.PHASE] === PHASE.LIVE && m.N[I.POSS] === k && m.t - m.N[I.CHGT] < c.winW ? c.t.onWin : 0;
}

// 点 (x,y) の周りの、相手チームの圧力（6m以内の相手の近さの合計。最大1.5）
// aw（認知。選手ごとの見えている度合い）があれば、見えている相手だけが圧力に入る。省略は全員が見えている
export function pressureAt(m, x, y, k, aw) {
  const { px, py } = m, j0 = (1 - k) * 11;
  let p = 0;
  for (let j = j0; j < j0 + 11; j++) {
    const dx = px[j] - x, dy = py[j] - y, d2 = dx * dx + dy * dy;
    if (d2 < 36) p += (aw ? aw[j] : 1) * (1 - Math.sqrt(d2) / 6);
  }
  return p > 1.5 ? 1.5 : p;
}

// チームkから見た相手の最終ライン（相手の後ろから2人目の位置。攻める向きを+にした座標）
export function offsideLine(m, k) {
  const dir = dirOf(m.N, k), o0 = (1 - k) * 11;
  let l1 = -1e9, l2 = -1e9;
  for (let j = o0; j < o0 + 11; j++) {
    const f = m.px[j] * dir;
    if (f > l1) { l2 = l1; l1 = f; } else if (f > l2) l2 = f;
  }
  return l2;
}

// ボールが (x0,y0)→(x1,y1) を初速 v0 で転がる間に、相手に触られずに済む確率。
// 相手は①今の位置（すぐ近くを通るなら動かなくても触れる）と、②反応するまで走り続けた先の位置から、走って間に合うかで見積もる。
export function laneSafe(m, k, x0, y0, x1, y1, v0, aw) { // aw: 認知（見えていない相手は、パスコースの危険に入らない）。省略は全員が見えている
  const { px, py, vx, vy, vmax, acc, ab } = m;
  const ex = x1 - x0, ey = y1 - y0, D2 = ex * ex + ey * ey, D = Math.sqrt(D2), o0 = (1 - k) * 11;
  let p = 1;
  for (let j = o0; j < o0 + 11; j++) {
    let r = 0;
    // ① 今いる場所を通る（出だしの0.2秒以内に、すぐそばを通る）
    for (let u = 0; u < 2 && r < 1; u++) { // 今の位置と、0.15秒走った先の位置
      const qx = px[j] + vx[j] * 0.15 * u, qy = py[j] + vy[j] * 0.15 * u;
      const raw = D2 > 1e-6 ? ((qx - x0) * ex + (qy - y0) * ey) / D2 : 0;
      const s = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const cx = x0 + ex * s - qx, cy = y0 + ey * s - qy;
      if (cx * cx + cy * cy <= (R_CTRL + 0.25) * (R_CTRL + 0.25) && D * s < 3) r = 1;
    }
    if (r < 1) { // ② 反応するまで走り続けた先から、間に合うか
      const rc = REACT_BASE - 0.1 + 0.02 * (20 - ab[j * NAB + AB.ANT]);
      const qx = px[j] + vx[j] * rc * 0.8, qy = py[j] + vy[j] * rc * 0.8;
      const raw = D2 > 1e-6 ? ((qx - x0) * ex + (qy - y0) * ey) / D2 : 0;
      const s = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const cx = x0 + ex * s - qx, cy = y0 + ey * s - qy, dq = Math.sqrt(cx * cx + cy * cy);
      if (dq <= R_CTRL + 0.3 && raw > 0.02) r = 1; // 進路上に立っている
      else {
        const v = v0 - K_ROLL * D * s;
        const tb = v > 0.5 ? log(v0 / v) / K_ROLL : 9; // ボールがそこへ着く時間
        const tq = rc + timeToCover(dq - R_CTRL, vmax[j], acc[j]); // 相手が着く時間（反応の遅れつき）
        const q = 0.5 + (tb - tq) / 0.5;
        r = q < 0 ? 0 : q > 1 ? 1 : q;
      }
    }
    p *= 1 - 0.9 * r * (aw ? aw[j] : 1);
  }
  return p;
}

// ボールを受けてから次の判断までの tick（判断力が高いほど早く、圧力が強いほど急ぐ）
export function reactTicks(m, p, press) {
  const q = clamp(1 - 0.55 * press, 0.3, 1);
  return Math.round(clamp((8 + (18 + 0.8 * (20 - m.ab[p * NAB + AB.DEC])) * q * q) * m.tac[m.team[p]].reactK, 6, 50)); // reactK: 指示 テンポ（標準 1）
}

// 保持者 i が運ぶ先の候補を全部採点して、cb(価値, 目標x, 目標y, 走る強さ, 距離) に渡す。
// 価値 = 運んだ先のxt + 相手の圧力が減る分 + 今の勢いを続ける分 − 途中で奪われる危険。hold=true のときは「その場でボールを守る」も候補に入れる。
export function carryOptions(m, i, press, hold, cb, aw) { // aw: 認知（見えている度合い。省略は全員が見えている）
  const { px, py, vx, vy, team, ab, N } = m;
  const k = team[i], dir = dirOf(N, k), A = i * NAB, o0 = (1 - k) * 11;
  const x = px[i], y = py[i], fx = x * dir, fy = y * dir, dri = ab[A + AB.DRI], shtF = 0.4 + 0.06 * ab[A + AB.SHT];
  const ap = m.tac[k], wa = winMode(m, k), wv = 1 + WIN_K * wa; // 奪った直後: 前へ進める価値の倍率（wv）。失う危険の重みは LOSS_W × (1 - WIN_K×wa) × lossK（指示 リスク）
  const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]), lossV = LOSS_W * (1 - WIN_K * wa) * ap.lossK * xt(-fx, fy) + KEEP, pr = press > 1 ? 1 : press;
  const held = (m.t - N[I.GOT]) * 0.05, tired = held > ap.hold0 ? HOLD_W * (held - ap.hold0) : 0; // 持ち続けた時間によるぶん
  for (let li = hold ? -1 : 0; li < 2; li++) {
    for (let u = 0; u < (li < 0 ? 1 : 7); u++) {
      const L = li < 0 ? 0 : CL[li], ux = li < 0 ? 0 : CD[u][0], uy = li < 0 ? 0 : CD[u][1];
      const dfx = clamp(fx + ux * L, -HL + 2, HL - 3), dfy = clamp(fy + uy * L, -HW + 1.5, HW - 1.5);
      const dx = dfx * dir, dy = dfy * dir, ex = dx - x, ey = dy - y, D2 = ex * ex + ey * ey;
      if (li >= 0 && D2 < 6.25) continue; // 2.5m も進めない（タッチライン際など）
      let keep = 1;
      for (let q = o0; q < o0 + 11; q++) { // 進路の近くにいる相手（動きを0.3秒先まで見込む）
        const qx = px[q] + vx[q] * 0.3, qy = py[q] + vy[q] * 0.3;
        let s = D2 > 1e-6 ? ((qx - x) * ex + (qy - y) * ey) / D2 : 0;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
        const cx = x + ex * s - qx, cy = y + ey * s - qy, d = Math.sqrt(cx * cx + cy * cy);
        if (d < 4.5) keep *= 1 - (aw ? aw[q] : 1) * clamp(0.55 * (1 - d / 4.5) + 0.03 * (ab[q * NAB + AB.TCK] - dri), 0, 0.75);
      }
      const pd = pressureAt(m, dx, dy, k, aw), dist = Math.sqrt(D2);
      keep *= 1 - 0.08 * (pd > 1 ? 1 : pd);
      const pace = clamp(0.4 + 0.012 * dri + 0.22 * (ux > 0 ? ux : 0) * (1 - 0.4 * pr), 0.4, 0.9);
      if (dist > 0.1) { // 走る間のタッチミスで、半分ほどは奪われる
        const vc = m.vmax[i] * pace;
        keep *= 1 - 0.5 * touchHazard(vc, (press + pd) * 0.5, dri, ab[A + AB.BAL]) * dist / vc;
      }
      // 今の勢いを続ける価値。認知ありのときは体の向きで見る（止まっていても、向いている方へ運ぶほうが楽。背を向けていると、前へ運ぶには向きを変える手間がかかる）
      const mom = m.pOn ? MOM * (0.4 + 0.6 * (sp > 5 ? 1 : sp / 5)) * (dist > 0.1 ? (m.fcx[i] * ex + m.fcy[i] * ey) / dist : -1)
        : sp > 1.5 ? MOM * (sp > 5 ? 1 : sp / 5) * (dist > 0.1 ? (vx[i] * ex + vy[i] * ey) / (sp * dist) : -1) : 0;
      const V = K_DRIB * (keep * (zoneCap(m, k, dir, dfx, dfy, pd, xt(dfx, dfy) * prsF(pd) * wv * latM(ap, dfx, dfy), shtF) + KEEP + RELIEF * (press - pd)) - (1 - keep) * lossV) + mom - (li < 0 ? 0 : CARRY_COST + CARRY_M * dist + tired);
      cb(V, dx, dy, pace, dist);
    }
  }
}

// ボールを受けた直後: 止まらずに運び出す（相手から離れる・空いた方・今の勢いの向き）。その場で守るほうが良ければ止まる。
export function startCarry(m, p, press) {
  const { px, py, vx, vy, tx, ty, pc, ab, seed, t } = m, A = p * NAB;
  const aw = m.pOn ? seeAll(m, p) : null; // 認知: 見えている相手だけで、運ぶ先を選ぶ
  const sig = 0.04 + 0.008 * (20 - (ab[A + AB.DEC] + ab[A + AB.VIS]) / 2);
  let bw = -1e9, n = 0;
  tx[p] = px[p] + vx[p] * 0.3; ty[p] = py[p] + vy[p] * 0.3; pc[p] = 0.5;
  carryOptions(m, p, press, true, (V, dx, dy, pace, dist) => {
    const w = V * (1 + sig * normal4(seed, t, p, 300 + n)) + 0.002 * normal4(seed, t, p, 340 + n);
    n++;
    if (w > bw && dist >= 0.1) { bw = w; tx[p] = dx; ty[p] = dy; pc[p] = pace; }
    else if (w > bw) { bw = w; tx[p] = px[p] + vx[p] * 0.3; ty[p] = py[p] + vy[p] * 0.3; pc[p] = 0.5; }
  }, aw);
}

// 蹴る。向きと強さに誤差が乗る。dx,dy=狙い点、v0=水平方向の初速、vz=上向きの初速
function kick(m, i, dx, dy, v0, vz, sigAng, sigSpd, tg) {
  const { F, N, t, seed } = m, bx = F[F_B], by = F[F_B + 1];
  const a = atan2(dy - by, dx - bx) + normal4(seed, t, i, tg) * sigAng;
  const v = v0 * (1 + normal4(seed, t, i, tg + 1) * sigSpd);
  F[F_B + 3] = cos(a) * v; F[F_B + 4] = sin(a) * v; F[F_B + 5] = vz;
  F[F_B + 6] = bx; F[F_B + 7] = by;
  N[I.OWN] = -1; N[I.LAST] = i; N[I.KICKT] = m.t; m.cd[i] = 10; m.act[i] = ACT.HOME; m.tmr[i] = 0;
}

// ボールを持っている選手 i が次の行動を決めて実行する
export function decide(m, i) {
  const { px, py, vx, vy, team, slot, role, ab, vmax, acc, F, N, t, seed } = m;
  const k = team[i], dir = dirOf(N, k), A = i * NAB, gk = slot[i] === 0, j0 = k * 11, o0 = (1 - k) * 11;
  const sp = N[I.SETP]; // 再開（スローイン・ゴールキック・コーナー）の最初のプレーか。蹴るだけで、運ぶ・撃つ・クリアはしない
  const x = px[i], y = py[i], fx = x * dir, fy = y * dir;
  const aw = m.pOn ? seeAll(m, i) : null; // 認知: 自分から見て、周りの選手がどれだけ見えているか（オフなら全員が見えている）
  const press = pressureAt(m, x, y, k), line = offsideLine(m, k);
  const sig = 0.04 + 0.008 * (20 - (ab[A + AB.DEC] + ab[A + AB.VIS]) / 2); // 見え方の誤差（点数に対する割合）
  const vis = 10 + 2.5 * ab[A + AB.VIS]; // 見える範囲 (m)
  const pas = ab[A + AB.PAS], lng = gk ? ab[A + AB.GKD] : ab[A + AB.LNG];
  const pe = 1 + 0.5 * press * (1 - 0.03 * ab[A + AB.CMP]); // 圧力による蹴りの乱れ
  const ap = m.tac[k], wa = winMode(m, k), wv = 1 + WIN_K * wa, lw = LOSS_W * (1 - WIN_K * wa) * ap.lossK; // 奪った直後の窓・リスクの指示（標準は、倍率はすべて 1）

  let bV = -1e9, bt = 0, bj = -1, bdx = 0, bdy = 0, bpc = 0.5, bdist = 0, tag = 0;
  const consider = (V, type, j, dx, dy, pace, dist) => {
    const w = V * (1 + sig * normal4(seed, t, i, 100 + tag)) + 0.002 * normal4(seed, t, i, 200 + tag);
    tag++;
    if (w > bV) { bV = w; bt = type; bj = j; bdx = dx; bdy = dy; bpc = pace; bdist = dist; }
  };

  // --- パス（足元・スペース）---
  const evalPass = (j, space) => {
    const jx = px[j], jy = py[j], B = j * NAB;
    let dx, dy;
    if (space) { dx = jx + dir * 10; dy = jy * 0.85; } // 受け手の前のスペース
    else {
      const T0 = Math.sqrt((jx - x) * (jx - x) + (jy - y) * (jy - y)) / 16;
      dx = jx + vx[j] * T0; dy = jy + vy[j] * T0; // 動きを見越して少し先へ
    }
    dx = clamp(dx, -HL + 1.5, HL - 1.5); dy = clamp(dy, -HW + 1.5, HW - 1.5);
    const ex = dx - x, ey = dy - y, D = Math.sqrt(ex * ex + ey * ey);
    if (D < 3 || D > 55 || (sp === SP.THROW && D > 24)) return;
    const dfx = dx * dir, dfy = dy * dir, pd = pressureAt(m, dx, dy, k, aw);
    const air = sp === SP.CORNER && D > 8; // コーナーは浮き球でゴール前へ
    let p;
    if (D <= 26 && !air) {
      const g = groundPass(D, rollRoom(dx, dy, ex / D, ey / D));
      if (g.v0 > 18 + 0.9 * lng) return; // 強く蹴れない距離
      p = laneSafe(m, k, x, y, dx, dy, g.v0, aw);
      const rx = jx - dx, ry = jy - dy;
      const tr = 0.1 + timeToCover(Math.sqrt(rx * rx + ry * ry) - 0.5, vmax[j], acc[j]); // 受け手がそこへ着く時間
      const lag = tr - g.T;
      if (lag > 0.3) p *= clamp(1 - (lag - 0.3), 0, 1);
      p *= clamp(1 / (1 + exp(-0.681 * touchMean(ab[B + AB.TRP], ab[B + AB.CMP], g.vA, pd))), 0.05, 0.99) * (space ? 0.94 : 1); // 受け手が止められる確率（onTouch と同じ式。1.702/2.5=0.681）
      const sg = D * Math.max(0.02, 0.1 - 0.0045 * pas) * pe;
      p *= 1 / (1 + (sg * sg) / 10.24);
    } else {
      let n = 0; // 浮き球: 着地点の周りの相手の数
      for (let q = o0; q < o0 + 11; q++) { const qx = px[q] - dx, qy = py[q] - dy; if (qx * qx + qy * qy < 49) n++; }
      p = clamp(0.66 - 0.13 * n + 0.01 * ab[B + AB.TRP], 0.15, 0.8) * 0.55; // 競り合い・ファーストタッチ・ラインを割るぶんを織り込む（実測に合わせた）
      const sg = D * Math.max(0.03, 0.12 - 0.005 * lng) * pe;
      p *= 1 / (1 + (sg * sg) / 20.25);
    }
    const V = K_PASS * (p * (zoneCap(m, k, dir, dfx, dfy, pd, xt(dfx, dfy) * prsF(pd) * wv * latM(ap, dfx, dfy), 0.4 + 0.06 * ab[B + AB.SHT]) + KEEP) - (1 - p) * (lw * xt(-dfx, dfy) + KEEP)) + 0.012 * press * p - (D > 26 ? 0.012 : 0) - ap.passCost;
    consider(V, D <= 26 && !air ? 2 : 3, j, dx, dy);
  };
  for (let j = j0; j < j0 + 11; j++) {
    if (j === i) continue;
    const jx = px[j], jy = py[j], ddx = jx - x, ddy = jy - y, dd = Math.sqrt(ddx * ddx + ddy * ddy);
    if (dd < 4 || dd > vis) continue;
    if (aw && aw[j] <= f4(seed, t, i, 400 + j)) continue; // 認知: 見えている度合いが、そのときの候補に入る確率（見えていない味方には出せない。見えていれば必ず入る）
    if (slot[j] === 0 && fx > -22) continue; // GKへ戻すのは自陣深くだけ
    if (jx * dir > line + 0.3) continue; // すでにオフサイドの位置の味方には出さない
    evalPass(j, false);
    if (sp !== SP.CORNER && ddx * dir > -3 && (role[j] >= ROLE.M || role[j] === ROLE.S)) evalPass(j, true);
  }

  // --- シュート ---
  if (!gk && sp === SP.NONE) {
    const dgx = HL - fx;
    if (dgx > 0.3 && dgx < 32) {
      const shtF = 0.4 + 0.06 * ab[A + AB.SHT], raw = xgAt(dgx, fy) * shtF; // raw = 位置と能力だけの見込み
      const xg0 = shotQ(m, k, dir, fx, fy, press, shtF); // 相手・圧力を織り込んだ見込み
      const xg = xg0 * (SHOT_LO + (SHOT_HI - SHOT_LO) * clamp((raw - SHOT_X0) / SHOT_XW, 0, 1));
      consider(xg * ap.shtK + 0.004, 1, -1, HL * dir, 0); // shtK: 指示 リスク（冒険するほど撃つ。標準 1）
    }
  }

  // --- ドリブル（運ぶ）---
  if (!gk && sp === SP.NONE) carryOptions(m, i, press, false, (V, dx, dy, pace, dist) => consider(V, 4, -1, dx, dy, pace, dist), aw);

  // --- クリア（自陣で強く寄せられているとき）---
  if (!gk && sp === SP.NONE && fx < -28 && press > 0.4) {
    consider(0.010 + 0.025 * press, 3, -1, x + dir * 36, clamp(y * 0.4, -20, 20));
    consider(0.009 + 0.022 * press, 3, -1, x + dir * 12, y > 0 ? HW + 4 : -HW - 4); // 外（タッチライン）へ蹴り出す。相手ボールのスローインになる
  }
  if (bt === 0) { bt = 3; bj = -1; bdx = clamp(x + dir * 40, -HL + 3, HL - 3); bdy = clamp(y * 0.3, -25, 25); } // 選択肢が無いとき

  // --- 実行 ---
  N[I.SETP] = SP.NONE; // 再開のプレーはこれで終わり
  if (bt === 4) { // 運ぶ: 進む先と速さを決めて、半分ほど進んだらまた考える
    m.tx[i] = bdx; m.ty[i] = bdy; m.pc[i] = bpc;
    m.tmr[i] = clamp(Math.round(11 * bdist / (m.vmax[i] * bpc)), 8, 24);
    N[I.ST + k * ST_N + ST.DRIB]++;
    return;
  }
  if (bt === 1) { // シュート: GKと反対側の隅を狙う
    const gyf = py[o0] * dir;
    const side = gyf > 0.3 ? -1 : gyf < -0.3 ? 1 : (normal4(seed, t, i, 30) > 0 ? 1 : -1);
    const sht = ab[A + AB.SHT];
    const ay = side * (GOAL_HW - Math.max(0.35, 1.7 - 0.08 * sht)) * dir, ax = HL * dir;
    const D = Math.sqrt((ax - x) * (ax - x) + (ay - y) * (ay - y));
    const v0 = clamp(16 + sht, 18, 32), te = D / (v0 * 0.9);
    let vz = clamp((0.9 + 4.9 * te * te - BALL_R) / te, 0.5, 9) + normal4(seed, t, i, 34) * 1.8;
    if (vz < 0) vz = 0;
    kick(m, i, ax, ay, v0, vz, Math.max(0.045, 0.45 - 0.018 * sht) * (1 + 0.35 * press) * clamp(D / 18, 0.6, 1.4), 0.06, 36);
    N[I.SHOTS + k]++; N[I.SHOTK] = k; N[I.SHOTT] = t;
    m.log.push([t, EV.SHOT, k, i]);
    const vxb = F[F_B + 3], vyb = F[F_B + 4]; // 枠内かどうか（直進で見積もる。統計用）
    if (vxb * dir > 1) {
      const tc = (HL * dir - F[F_B]) / vxb, yc = F[F_B + 1] + vyb * tc, zc = BALL_R + vz * tc - 4.9 * tc * tc;
      if (Math.abs(yc) < GOAL_HW && zc > 0 && zc < GOAL_H) N[I.ST + k * ST_N + ST.SOT]++;
    }
    return;
  }
  const dd = Math.sqrt((bdx - x) * (bdx - x) + (bdy - y) * (bdy - y));
  if (bt === 2) kick(m, i, bdx, bdy, groundPass(dd, rollRoom(bdx, bdy, (bdx - x) / dd, (bdy - y) / dd)).v0, 0, Math.max(0.02, 0.1 - 0.0045 * pas) * pe, 0.05, 30);
  else {
    const l = lobPlan(dd);
    N[I.ST + k * ST_N + (bj >= 0 ? ST.LOB : ST.CLR)]++;
    kick(m, i, bdx, bdy, l.vh, l.vz, Math.max(0.03, 0.12 - 0.005 * lng) * pe, 0.06, 30);
  }
  if (bj >= 0) {
    N[I.RECV] = bj; N[I.PASSK] = k; F[F_PASS] = bdx; F[F_PASS + 1] = bdy;
    N[I.ST + k * ST_N + ST.PASS]++;
    const r = role[i];
    if (r === ROLE.S || r >= ROLE.M) { m.act[i] = ACT.FOLLOW; m.tmr[i] = 40; } // 出したあとも前へ関わる
  } else { N[I.RECV] = -1; N[I.PASSK] = -1; }
}
