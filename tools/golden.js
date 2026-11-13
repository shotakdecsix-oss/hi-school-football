// 基準値（tools/golden.json と、実機の自己診断の基準 data/selfcheck.js）の作成。エンジンを意図して変えたときだけ --write で更新する。
//   node tools/golden.js          … 計算結果を表示
//   node tools/golden.js --write  … tools/golden.json を更新
import { writeFileSync } from 'node:fs';
import { computeGolden } from './golden-core.js';
import { selfDigest } from '../engine/selfcheck.js';
import { ENGINE_VERSION } from '../engine/consts.js';

const text = JSON.stringify(await computeGolden(), null, 2) + '\n';
if (process.argv.includes('--write')) {
  writeFileSync(new URL('./golden.json', import.meta.url), text);
  writeFileSync(new URL('../data/selfcheck.js', import.meta.url), `// 実機の自己診断の基準（engine/selfcheck.js）。npm run golden が書く。手で編集しない。\nexport const SELF_CHECK = { engine: ${ENGINE_VERSION}, digest: '${selfDigest()}' };\n`);
  console.log('tools/golden.json と data/selfcheck.js を更新した');
} else {
  process.stdout.write(text);
}
