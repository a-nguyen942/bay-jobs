import { chmod, readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';

// Build tooling copies local dev settings into dist/server. Keep both copies
// owner-readable only; neither belongs in the browser's asset directory.
const privateValues = [];
for (const path of ['.dev.vars', '.env', '.env.local', 'dist/server/.dev.vars']) {
    try {
        await chmod(path, 0o600);
        for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
            const match = /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
            if (!match) continue;
            const value = match[1].replace(/^(['"])(.*)\1$/, '$2');
            if (value.length >= 8) privateValues.push(value);
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const files = await readdir('dist/client', { recursive: true, withFileTypes: true });
for (const entry of files) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|wrangler(?:\.[^.]+)?\.(?:jsonc?|toml))$/.test(basename(path)))
        throw new Error(`Private configuration found in public assets: ${path}`);
    const content = await readFile(path, 'utf8');
    if (privateValues.some(value => content.includes(value)) || /\bre_[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))
        throw new Error(`Possible private value found in public assets: ${path}. Value omitted.`);
}
console.log('Public assets checked; local secret files restricted to their owner.');
