import { existsSync } from 'node:fs';

// Keep production database identifiers in an ignored local configuration.
export const cloudflareConfig = () => existsSync('wrangler.production.json')
    ? 'wrangler.production.json'
    : 'wrangler.json';
