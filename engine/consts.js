// 定数と状態の並び。engine/ のほかのファイルはここから読む。

// 試合の結果が変わる修正をしたら上げる。保存した試合の再生可否の判定に使う（tools/golden.json も更新する）。
export const ENGINE_VERSION = 11;

// 時間（固定刻み）。時刻は整数の tick で数え、秒の小数は持たない。
export const TICK_HZ = 20;
export const DT = 1 / TICK_HZ;
// 試合の長さは大会ごとの規定（input.rules。data/rules.js）で決まる。下の2つは既定（リーグ戦: 45分×2）のときの長さ。
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
export const F_STA = F_SB + 4; // 選手ごとのスタミナ（1=万全〜0）。走ると減り、ゆっくり動くと回復する。減るほど最高速度・加速度が落ちる（engine/stamina.js）
export const F_LEN = F_STA + NP;

// 状態 N（Int32Array）の並び。選手ごとの4本のあと、全体の値
export const N_CD = 0; // 選手ごと: クールダウン（ボールに触れない・タックルできない残り tick）
export const N_ACT = NP; // 選手ごと: 今の役割（ACT）
export const N_TGT = 2 * NP; // 選手ごと: 役割の相手（マーク相手・プレス役など）。なければ -1
export const N_TMR = 3 * NP; // 選手ごと: 保持者は次の判断までの tick、FOLLOW は残り時間
const G = 4 * NP;
export const I = {
  PHASE: G, TIMER: G + 1, NEXT: G + 2, RTEAM: G + 3, LOCK: G + 4, LOCKT: G + 5, LAST: G + 6, HALF: G + 7, // HALF: 今の区間（1=前半 2=後半 3=延長前半 4=延長後半 5=PK戦）
  SCORE: G + 8, SHOTS: G + 10, // 各2つ（チーム0, 1）
  OWN: G + 12, // ボールを持っている選手（いなければ -1）
  POSS: G + 13, // ボールを保持しているチーム（直近に持った側）
  RECV: G + 14, // 飛んでいるパスの受け手（なければ -1）
  PASSK: G + 15, // 飛んでいるパスを出したチーム（なければ -1）
  SHOTT: G + 16, SHOTK: G + 17, // 直近のシュートの tick と、撃ったチーム（なければ -1）
  PLANK: G + 18, // チームごとの役割割り当ての鍵（2つ）
  KICKT: G + 20, // 直近にボールが蹴られた・弾かれた tick（守備側の反応の遅れの起点）
  GOT: G + 21, // 今の保持者がボールをコントロールした tick（持ち続けた時間の起点）
  SETP: G + 22, // 再開（セットプレー）の種類（SP）。0 = 通常のプレー中。ボールが蹴られるまで続く
  TAKER: G + 23, // 再開を行う選手（PK戦ではキッカー）
  // PK戦（HALF=5）の状態
  PKS: G + 24, // 手順: 0=位置につく 1=構える 2=ボールが飛んでいる 3=結果を見せる 4=助走
  PKT: G + 25, // 手順ごとのタイマー（tick）
  PKN: G + 26, // ここまでに蹴った本数（両チームの合計）
  PKF: G + 27, // 先攻のチーム
  PKG: G + 28, // 各チームのPKの得点（2つ）
  PKD: G + 30, // GKが跳んだ向き（-1, 0, +1）
  PKR: G + 31, // 直近のキックの結果（-1=まだ 0=外れ 1=ゴール 2=セーブ）
  PKK: G + 32, // いま蹴るチーム（全員が同じゴール +x へ蹴る）
  // 選手交代
  PAUSET: G + 33, // いまの中断（PAUSE）が始まった tick。交代の「機会」を見分けるのに使う
  SUBI: G + 34, // 次に処理する交代（m.changes の何番目か）
  SUBN: G + 35, // 各チームの交代人数（2つ）
  SUBO: G + 37, // 各チームの交代の機会の回数（2つ。ハーフタイム・延長前の交代は数えない）
  SUBT: G + 39, // 各チームが最後に交代した中断の PAUSET（2つ。-1 = まだ）
  BUSED: G + 41, // 各チームの、出場済みの控えの印（ビット。2つ）
  OCC: G + 43, // 22人それぞれの、いまの出場者（-1 = 先発、0以上 = 控えの番号）
  CHGT: G + 65, // 直近にボールを保持するチームが入れ替わった（相手が奪った）tick。切り替えの窓（失った直後・奪った直後）の起点。中断・キックオフで消える
  ST: G + 66, // 統計: チームごとに ST_N 個
};
export const ST_N = 15;
export const ST = { PASS: 0, PASSOK: 1, SOT: 2, SAVE: 3, TKL: 4, TKLW: 5, ICPT: 6, MISC: 7, DRIB: 8, LOB: 9, CLR: 10, HEAVY: 11, THROW: 12, GKICK: 13, CORNER: 14 };
export const N_LEN = I.ST + 2 * ST_N;
export const PHASE = { LIVE: 0, PAUSE: 1, END: 2, PK: 3 };
export const NEXT = { KICKOFF: 0, RESTART: 1 };
// 再開の種類。止まっている間（PAUSE）に、蹴る選手がボールの位置へ向かい、相手は離れる。待ち時間は種類ごと（tick）
export const SP = { NONE: 0, THROW: 1, GKICK: 2, CORNER: 3 };
export const SP_WAIT = [0, 100, 140, 200], GOAL_WAIT = 160;
// 出来事の記録 [t, 種類, ...]。HALF=前半/延長前半が終わった [t,4,得点0,得点1]、ET=延長に入る、PK=PK戦に入る、FULL=試合終了、
// OUT=ボールが出た [t,3,出た方向,再開するチーム]、RESTART=再開した [t,11,種類(SP),蹴る選手]
export const EV = { GOAL: 1, SHOT: 2, OUT: 3, HALF: 4, FULL: 5, SAVE: 6, ET: 7, PK: 8, PKK: 9, SUB: 10, RESTART: 11 };

// 選手の役割（その場の動き方）
export const ACT = { HOME: 0, CARRY: 1, PRESS: 2, COVER: 3, MARK: 4, SUPPORT: 5, RUN: 6, RECV: 7, FOLLOW: 8, CHASE: 9 };

// ボールの軌道の予測（0.25秒刻みで PRED_N 点）
export const PRED_N = 15;

// チームkが攻める向き（+1 = +x方向）。前半（と延長前半）はチーム0が+x、後半（と延長後半）は入れ替わる。
export const dirOf = (N, k) => (N[I.HALF] === 5 ? (k === N[I.PKK] ? 1 : -1) : ((k === 0) === ((N[I.HALF] & 1) === 1) ? 1 : -1)); // 区間ごとに攻める向きが入れ替わる。PK戦は蹴る側が +x のゴールへ
