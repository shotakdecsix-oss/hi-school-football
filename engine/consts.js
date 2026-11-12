// 定数と状態の並び。engine/ のほかのファイルはここから読む。

// 試合の結果が変わる修正をしたら上げる。保存した試合の再生可否の判定に使う（tools/golden.json も更新する）。
export const ENGINE_VERSION = 1;

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
export const F_B = 6 * NP; // ボール: x, y, z, vx, vy, vz, 前tickのx, 前tickのy
export const F_R = F_B + 8; // 再開位置 x, y
export const F_LEN = F_R + 2;

// 状態 N（Int32Array）の並び。0〜21 は選手ごとのクールダウン(tick)
export const I = { PHASE: 22, TIMER: 23, NEXT: 24, RTEAM: 25, LOCK: 26, LOCKT: 27, LAST: 28, HALF: 29, SCORE: 30, SHOTS: 32 };
export const N_LEN = 34;
export const PHASE = { LIVE: 0, PAUSE: 1, END: 2 };
export const NEXT = { KICKOFF: 0, RESTART: 1 };
export const EV = { GOAL: 1, SHOT: 2, OUT: 3, HALF: 4, FULL: 5 };

// チームkが攻める向き（+1 = +x方向）。前半はチーム0が+x、後半は入れ替わる。
export const dirOf = (N, k) => ((k === 0) === (N[I.HALF] === 1) ? 1 : -1);
