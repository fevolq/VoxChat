import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
for (const folder of ['src', 'client', 'scripts', 'dist', 'tests']) {
  for (const entry of await readdir(new URL('../' + folder + '/', import.meta.url), { withFileTypes: true })) {
    if (!entry.isFile() || !/\.m?js$/.test(entry.name)) continue;
    const path = fileURLToPath(new URL('../' + folder + '/' + entry.name, import.meta.url));
    const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
console.log('Syntax checks passed');
