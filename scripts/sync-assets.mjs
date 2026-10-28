import { readFile, readdir, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const { version } = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const checking = process.argv.includes('--check');
const stale = [];
for (const name of await readdir(new URL('dist/', root))) {
  if (!/\.(js|html)$/.test(name)) continue;
  const file = new URL(`dist/${name}`, root);
  const source = await readFile(file, 'utf8');
  const updated = name.endsWith('.js')
    ? source.replace(/(from\s+['"]\.\/[^'"?]+\.js)(?:\?v=[^'"]*)?(['"])/g, `$1?v=${version}$2`)
    : source.replace(/((?:src|href)="\.\/[^"?]+\.(?:js|css))(?:\?v=[^"]*)?(".*?)/g, `$1?v=${version}$2`);
  if (updated !== source) {
    stale.push(name);
    if (!checking) await writeFile(file, updated);
  }
}
if (checking && stale.length) { console.error(`静态资源版本待同步：${stale.join(', ')}；请运行 npm run assets。`); process.exitCode = 1; }
else console.log(`静态资源版本 ${version} 已同步${checking ? '并验证' : ''}。`);
