// チーム指示（設計書11の13項目）。値は -1〜+1 の数で、0 が標準（これまでの動きと同じ）。
// lo は -1 側、hi は +1 側の意味。on は、いまのエンジンで効く項目（段階ごとにつないでいく）。
// 理論の名前（ゲーゲンプレスなど）は、この指示の組み合わせ（おすすめ設定）として後から用意する。
export const TACTICS = [
  { key: 'build', group: '攻撃', name: '組み立て', lo: 'ショートパスでつなぐ', hi: 'ロングボールで進める', on: false },
  { key: 'tempo', group: '攻撃', name: 'テンポ', lo: 'ゆっくり', hi: '速く', on: false },
  { key: 'width', group: '攻撃', name: '幅', lo: '狭く', hi: '広く', on: false },
  { key: 'attack', group: '攻撃', name: '攻め方', lo: '中央から', hi: 'サイドから', on: false },
  { key: 'risk', group: '攻撃', name: 'リスク', lo: '安全に（後ろに残す）', hi: '冒険する（全員で攻める）', on: true },
  { key: 'line', group: '守備', name: 'ライン高さ', lo: '低い', hi: '高い', on: true },
  { key: 'pressZone', group: '守備', name: 'プレス開始位置', lo: '自陣に引いて待つ', hi: '敵陣から', on: true },
  { key: 'pressPower', group: '守備', name: 'プレス強度', lo: '弱い（距離をとる）', hi: '強い（激しく寄せる）', on: true },
  { key: 'defStyle', group: '守備', name: '守り方', lo: 'ゾーン', hi: 'マンツーマン', on: true },
  { key: 'compact', group: '守備', name: 'コンパクトさ', lo: '間延び', hi: 'コンパクト', on: true },
  { key: 'trap', group: '守備', name: 'オフサイドトラップ', lo: 'しない', hi: 'する', on: false },
  { key: 'onWin', group: '切り替え', name: '奪った直後', lo: 'キープして落ち着く', hi: '縦に速く', on: true },
  { key: 'onLose', group: '切り替え', name: '失った直後', lo: 'すぐ戻る', hi: 'すぐ奪い返す', on: true },
];

// 入力（省略・一部だけ・範囲外・数でない値）を、全項目が -1〜+1 の数のオブジェクトにそろえる
export function normTactics(t) {
  const o = {};
  for (const d of TACTICS) {
    const v = t ? t[d.key] : 0;
    o[d.key] = typeof v === 'number' && v === v ? (v < -1 ? -1 : v > 1 ? 1 : v) : 0;
  }
  return o;
}
