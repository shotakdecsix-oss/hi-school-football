// 基準値（tools/golden.json）の作成。エンジンを意図して変えたときだけ --write で更新する。
//   node tools/golden.js          … 計算結果を表示
//   node tools/golden.js --write  … tools/golden.json を更新
import { writeFileSync } from 'node:fs';
import { computeGolden } from './golden-core.js';

const text = JSON.stringify(await computeGolden(), null, 2) + '\n';
if (process.argv.includes('--write')) {
  writeFileSync(new URL('./golden.json', import.meta.url), text);
  console.log('tools/golden.json を更新した');
} else {
  process.stdout.write(text);
}
