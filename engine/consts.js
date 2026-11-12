// 定数と状態の並び。engine/ のほかのファイルはここから読む。

// 試合の結果が変わる修正をしたら上げる。保存した試合の再生可否の判定に使う（tools/golden.json も更新する）。
export const ENGINE_VERSION = 4;

// 時間（固定刻み）。時刻は整数の tick で数え、秒の小数は持たない。
export const TICK_HZ = 20;
export const DT = 1 / TICK_HZ;
export const HALF_TICKS = 45 * 60 * TICK_HZ;
export const FULL_TICKS = 2 * HALF_TICKS;

// ピッチ（メートル。中心が原点、x=長辺、y=短辺、z=高さ）
export const HL = 52.5, HW = 34;
export const GOAL_HW = 3.66, GOAL_H = 2.44;
export const BALL_R = 0.11;
export const PA_D = 16.5, PA_HW = 20.16, GA_D = 5.5, GA_HW = 9.16, PEN_X = 11, CIRCLE_R = 9.15;

// 選手数。0〜10 = チーム0、11〜21 = チーム1。各チーム内の位置(0〜10)がスロットで、0がGK。
export const NP = 22;

// 状態 F（Float64Array）の並び
export const F_PX = 0, F_PY = NP, F_VX = 2 * NP, F_VY = 3 * NP, F_TX = 4 * NP, F_TY = 5 * NP;
export const F_PC = 6 * NP; // 走る強さ（最高速度に対する割合 0〜1）
export const F_B = 7 * NP; // ボール: x, y, z, vx, vy, vz, 前tickのx, 前tickのy
export const F_R = F_B + 8; // 再開位置 x, y
export const F_PASS = F_R + 2; // 直近のパスの狙い x, y
export const F_SB = F_PASS + 2; // 陣形が基準にする「ならしたボール位置」（チームごとに x, y）。ボールにゆっくり追従する
export const F_LEN = F_SB + 4;

// 状態 N（Int32Array）の並び。選手ごとの4本のあと、全体の値
export const N_CD = 0; // 選手ごと: クールダウン（ボールに触れない・タックルできない残り tick）
export const N_ACT = NP; // 選手ごと: 今の役割（ACT）
export const N_TGT = 2 * NP; // 選手ごと: 役割の相手（マーク相手・プレス役など）。なければ -1
export const N_TMR = 3 * NP; // 選手ごと: 保持者は次の判断までの tick、FOLLOW は残り時間
const G = 4 * NP;
export const I = {
  PHASE: G, TIMER: G + 1, NEXT: G + 2, RTEAM: G + 3, LOCK: G + 4, LOCKT: G + 5, LAST: G + 6, HALF: G + 7,
  SCORE: G + 8, SHOTS: G + 10, // 各2つ（チーム0, 1）
  OWN: G + 12, // ボールを持っている選手（いなければ -1）
  POSS: G + 13, // ボールを保持しているチーム（直近に持った側）
  RECV: G + 14, // 飛んでいるパスの受け手（なければ -1）
  PASSK: G + 15, // 飛んでいるパスを出したチーム（なければ -1）
  SHOTT: G + 16, SHOTK: G + 17, // 直近のシュートの tick と、撃ったチーム（なければ -1）
  PLANK: G + 18, // チームごとの役割割り当ての鍵（2つ）
  KICKT: G + 20, // 直近にボールが蹴られた・弾かれた tick（守備側の反応の遅れの起点）
  GOT: G + 21, // 今の保持者がボールをコントロールした tick（持ち続けた時間の起点）
  ST: G + 22, // 統計: チームごとに ST_N 個
};
export const ST_N = 12;
export const ST = { PASS: 0, PASSOK: 1, SOT: 2, SAVE: 3, TKL: 4, TKLW: 5, ICPT: 6, MISC: 7, DRIB: 8, LOB: 9, CLR: 10, HEAVY: 11 };
export const N_LEN = I.ST + 2 * ST_N;
export const PHASE = { LIVE: 0, PAUSE: 1, END: 2 };
export const NEXT = { KICKOFF: 0, RESTART: 1 };
export const EV = { GOAL: 1, SHOT: 2, OUT: 3, HALF: 4, FULL: 5, SAVE: 6 };

// 選手の役割（その場の動き方）
export const ACT = { HOME: 0, CARRY: 1, PRESS: 2, COVER: 3, MARK: 4, SUPPORT: 5, RUN: 6, RECV: 7, FOLLOW: 8, CHASE: 9 };

// ボールの軌道の予測（0.25秒刻みで PRED_N 点）
export const PRED_N = 15;

// チームkが攻める向き（+1 = +x方向）。前半はチーム0が+x、後半は入れ替わる。
export const dirOf = (N, k) => ((k === 0) === (N[I.HALF] === 1) ? 1 : -1);
