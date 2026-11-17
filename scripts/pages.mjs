import { copyFile, mkdir, writeFile } from 'node:fs/promises';

const assets = new URL('../public/', import.meta.url);
const output = new URL('../dist-pages/', import.meta.url);
await mkdir(output, {recursive:true});
for (const file of ['index.html', 'app.js', 'styles.css', 'pages-demo.js']) {
  await copyFile(new URL(file, assets), new URL(file, output));
}
// The public demo has no wallet connection or signing code.
await writeFile(new URL('wallet.js', output), 'export function renderWallet() {}\n');
await writeFile(new URL('site.js', output), [
  "import { startDesk } from './app.js';",
  "import { demoFetch } from './pages-demo.js';",
  "startDesk(demoFetch);",
  ""
].join('\n'));
await writeFile(new URL('.nojekyll', output), '');
console.log('Built the isolated Pages demo in dist-pages/.');
