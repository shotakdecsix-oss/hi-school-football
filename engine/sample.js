// テスト・一括実行・ビューア用の試合入力を作る（仮。本物の部員データは段階3以降）。
import { hash4 } from './core/rng.js';

export function sampleInput(seed, o = {}) {
  const { home = '4-4-2', away = '4-4-2', abilHome = 10, abilAway = 10 } = o;
  const team = (k, formation, base) => ({
    formation,
    players: Array.from({ length: 11 }, (_, s) => ({
      id: 'T' + k + 'P' + s,
      ab: base + (hash4(seed, 900 + k, s, 1) / 4294967296 - 0.5) * 4,
    })),
  });
  return { seed, teams: [team(0, home, abilHome), team(1, away, abilAway)], changes: [] };
}
