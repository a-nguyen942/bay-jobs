// Run after migration 0013. Only derived search fields change; notes, URLs,
// discovery timestamps, and application state are untouched. Safe to rerun.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listingText, plainText, textKey } from '../lib/text.js';
import { experienceLevel } from '../lib/matching.js';
import { skillMask } from '../lib/skills.js';
import { cloudflareConfig } from './cloudflare-config.js';
export function backfillStatement(table, rows) {
    if (!['jobs', 'filtered_listings'].includes(table)) throw new Error('Invalid table');
    const payload = rows.map(row => {
        const job = { ...row, title: plainText(row.title), company: plainText(row.company), location: plainText(row.location) };
        return { ...row, searchText: listingText(job), titleKey: textKey(job.title),
            isIntern: Number(experienceLevel(job) === 'internship'), skills: skillMask(job.title) };
    });
    const literal = JSON.stringify(payload).replace(/'/g, "''");
    return `UPDATE ${table} SET search_text = json_extract(feed.value, '$.searchText'),
        skill_mask = skill_mask | json_extract(feed.value, '$.skills')
        ${table === 'jobs' ? ", title_key = json_extract(feed.value, '$.titleKey'), is_intern = json_extract(feed.value, '$.isIntern')" : ''}
        FROM json_each('${literal}') AS feed WHERE ${table}.id = json_extract(feed.value, '$.id')
        AND search_text IS NULL AND title = json_extract(feed.value, '$.title')
        AND company = json_extract(feed.value, '$.company') AND location = json_extract(feed.value, '$.location');`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const mode = process.argv[2];
    if (!['--local', '--remote'].includes(mode)) throw new Error('Specify --local or --remote');
    const run = args => {
        const output = execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', mode, '--json', '--config', cloudflareConfig(), ...args],
            { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs' } });
        // Wrangler file imports include upload progress even with --json.
        // Their exit code establishes success; only SELECT responses need parsing.
        return args.includes('--file') ? null : JSON.parse(output);
    };
    const directory = mkdtempSync(join(tmpdir(), 'bay-jobs-search-'));
    try {
        for (const table of ['jobs', 'filtered_listings']) {
            let count = 0;
            // Bound each request; keyset pagination avoids looping if a row changes mid-run.
            let cursor = '';
            while (true) {
                const escapedCursor = cursor.replace(/'/g, "''");
                const results = run(['--command', `SELECT id,title,company,location FROM ${table} WHERE search_text IS NULL AND id > '${escapedCursor}' ORDER BY id LIMIT 100`]);
                const rows = results[0].results;
                if (!rows.length) break;
                const file = join(directory, 'batch.sql');
                const batches = [rows];
                while (batches.length) {
                    const batch = batches.shift();
                    const sql = backfillStatement(table, batch);
                    if (Buffer.byteLength(sql) > 80000) {
                        if (batch.length === 1) throw new Error('A listing exceeds the safe backfill statement size');
                        const half = Math.ceil(batch.length / 2);
                        batches.unshift(batch.slice(0, half), batch.slice(half));
                        continue;
                    }
                    writeFileSync(file, sql);
                    run(['--file', file]);
                }
                count += rows.length; cursor = rows.at(-1).id;
            }
            console.log(`${table}: processed ${count} search records`);
        }
    } finally { rmSync(directory, { recursive: true, force: true }); }
}
