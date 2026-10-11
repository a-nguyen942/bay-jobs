import { spawnSync } from 'node:child_process';
import { cloudflareConfig } from './cloudflare-config.js';

const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', ...process.argv.slice(2),
    '--config', cloudflareConfig(),
], {
    stdio: 'inherit',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
