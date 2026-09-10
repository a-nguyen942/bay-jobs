import { sites } from '@openai/sites-vite-plugin';
import { defineConfig } from 'vite';
export default defineConfig(async () => {
    process.env.WRANGLER_WRITE_LOGS ??= 'false';
    process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
    process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';
    process.env.WRANGLER_SEND_METRICS ??= 'false';
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    return {
        server: {
            host: '127.0.0.1',
            ...(process.env.CODEX_SANDBOX === 'seatbelt' ? { watch: { useFsEvents: false, usePolling: true } } : {}),
        },
        plugins: [
            sites(),
            cloudflare({ viteEnvironment: { name: 'server' }, configPath: './wrangler.json' }),
        ],
    };
});
