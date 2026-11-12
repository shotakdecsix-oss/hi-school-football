// 大会ごとの試合規定。engine は input.rules としてこの形の値を受け取る（省略するとリーグ戦と同じ）。
// 出典・根拠は Project の「試合エンジンの合格ライン」の「大会規定」。神奈川の要項は未確認なので、選手権系は埼玉の要項に合わせてある。
//   half     前後半それぞれの長さ（分）
//   et       延長の前後半それぞれの長さ（分）。0 = 延長なし
//   pk       延長（なければ後半）のあとも同点ならPK戦をする
//   ko       ノックアウト戦。true のとき同点では終わらせない（et / pk に進む）。false はリーグ戦で、同点は引き分け
//   subs     交代できる人数（試合全体）
//   subTimes 交代できる回数（1回に複数人でもよい。ハーフタイム・延長前は数えない。延長で1回追加）
export const RULES = {
  sensyuken: { name: '選手権系（80分・延長・PK）', half: 40, et: 10, pk: true, ko: true, subs: 5, subTimes: 3 },
  interhigh: { name: 'インターハイ系（70分・PK）', half: 35, et: 0, pk: true, ko: true, subs: 5, subTimes: 3 },
  interhighFinal: { name: 'インターハイ決勝（70分・延長・PK）', half: 35, et: 10, pk: true, ko: true, subs: 5, subTimes: 3 },
  league: { name: 'リーグ戦（90分・仮）', half: 45, et: 0, pk: false, ko: false, subs: 5, subTimes: 3 },
};

// 入力の rules を、足りない項目を既定（リーグ戦）で埋めた形にする
export function normRules(r) {
  const d = RULES.league, o = r || d;
  return {
    half: o.half ?? d.half, et: o.et ?? d.et, pk: !!(o.pk ?? d.pk), ko: !!(o.ko ?? d.ko),
    subs: o.subs ?? d.subs, subTimes: o.subTimes ?? d.subTimes,
  };
}
