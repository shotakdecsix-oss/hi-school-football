// テスト・一括実行・ビューア用の試合入力を作る（仮。本物の部員データは段階3以降）。
// 能力32個は「基準値 + 役割ごとの偏り + ばらつき」で作る（万能にならないよう凸凹をつける）。
import { hash4 } from './core/rng.js';
import { AB } from './abil.js';
import { FORMATIONS, ROLE } from '../data/formations.js';

const R = ROLE;
const PROFILE = {
  [R.G]: { PAS: -1, LNG: 1, TRP: -2, DRI: -4, SHT: -5, CRS: -5, HED: -3, TCK: -3, MRK: -3, OFF: -6, SPD: -1.5, GKR: 4, GKC: 4, GK1: 3, GKH: 3, GKD: 2 },
  [R.C]: { PAS: -0.5, TRP: -1, DRI: -2.5, SHT: -3, CRS: -3, HED: 2.5, TCK: 2, MRK: 2.5, OFF: -2, POS: 1.5, STR: 1.5, JMP: 1.5, SPD: -0.5 },
  [R.S]: { SPD: 1, ACC: 0.5, STM: 1.5, WRK: 1.5, CRS: 1, TCK: 1, MRK: 1, DRI: -0.5, SHT: -2, HED: -0.5 },
  [R.D]: { PAS: 0.5, TCK: 2, MRK: 1, DEC: 1, POS: 1, WRK: 1.5, STM: 1, DRI: -1, SHT: -1.5, OFF: -1 },
  [R.M]: { PAS: 1.5, VIS: 1.5, DEC: 1, TRP: 1, WRK: 1, STM: 1, SHT: -0.5 },
  [R.W]: { SPD: 1.5, ACC: 1.5, DRI: 1.5, CRS: 1.5, OFF: 1, TCK: -1.5, HED: -1.5, MRK: -1.5 },
  [R.A]: { PAS: 1, DRI: 1, VIS: 1.5, SHT: 0.5, OFF: 1.5, TCK: -2, MRK: -2 },
  [R.F]: { SHT: 2, OFF: 2.5, ACC: 1, SPD: 0.5, HED: 0.5, DRI: 0.5, TCK: -3, MRK: -3, PAS: -0.5 },
};
const KEYS = Object.keys(AB); // 定義順 = 番号順

// 控え8人（GK1・守備2・中盤3・攻撃2）。先発より少しだけ能力が低い
const BENCH_ROLES = [R.G, R.D, R.C, R.M, R.W, R.A, R.F, R.S];

// changes は交代の指示 [{ t, k, type: 'sub', slot, bench }]（engine/match.js の入力を見る）
export function sampleInput(seed, o = {}) {
  const { home = '4-4-2', away = '4-4-2', abilHome = 10, abilAway = 10, rules, changes = [] } = o; // rules は data/rules.js の値（省略 = リーグ戦）
  const player = (k, s, role, base, id) => {
    const prof = PROFILE[role];
    const ab = KEYS.map((name, a) => {
      let v = base + (prof[name] || 0) + (hash4(seed, 900 + k, s * 40 + a, 1) / 4294967296 - 0.5) * 3;
      if (role !== R.G && a >= AB.GKR) v = base - 8; // 外野手のGK能力は使わない
      return Math.min(20, Math.max(1, v));
    });
    return { id, ab };
  };
  const team = (k, formation, base) => ({
    formation,
    players: FORMATIONS[formation].map((def, s) => player(k, s, def[2], base, 'T' + k + 'P' + s)),
    bench: BENCH_ROLES.map((role, b) => player(k, 11 + b, role, base - 1, 'T' + k + 'B' + b)),
  });
  return { seed, teams: [team(0, home, abilHome), team(1, away, abilAway)], changes, rules };
}
