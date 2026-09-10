import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directories = ['web', 'worker', 'lib', 'db', 'config', 'tests', 'scripts'];
const files = ['vite.config.js', ...directories.flatMap(directory =>
  readdirSync(path.join(root, directory), { recursive: true })
    .filter(file => file.endsWith('.js'))
    .map(file => path.join(directory, file)),
)];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`JavaScript syntax checked in ${files.length} files.`);
