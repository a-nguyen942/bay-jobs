import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const privateValues = [];
for (const file of readdirSync('.').filter(name => /^\.(?:env|dev\.vars)(?:\.|$)/.test(name) && !name.endsWith('.example'))) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) continue;
        const value = match[1].replace(/^(['"])(.*)\1$/, '$2');
        if (value.length >= 8) privateValues.push(value);
    }
}
let failed = false;
const privatePath = /(?:^|\/)(?:\.env(?:\.(?!example$).*)?|\.dev\.vars(?:\.(?!example$).*)?|wrangler\.production\.json|toPrompt\.txt|usage-report\.json|[^/]+\.(?:pem|key|p12|pfx))$|^(?:dist|\.wrangler|node_modules)\/|^verification\/cpu-safety\/(?:REPORT\.md|.*-results\.json)$/;
const credential = /\b(?:re_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:[A-Z ]* )?PRIVATE KEY-----/;
function inspect(file, content, origin) {
    const emails = content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) ?? [];
    const personalEmail = emails.some(email => !/@(?:example\.(?:com|org|net|invalid)|users\.noreply\.github\.com)$/i.test(email));
    if (privatePath.test(file) || credential.test(content) || privateValues.some(value => content.includes(value)) || personalEmail) {
        console.error(`Possible private data: ${origin}:${file}. Values omitted.`);
        failed = true;
    }
}
const staged = process.argv.includes('--staged');
const paths = git(staged ? ['ls-files', '-z'] : ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
for (const file of new Set(paths)) {
    if (staged) inspect(file, git(['show', `:${file}`]), 'index');
    else {
        try { inspect(file, readFileSync(file, 'utf8'), 'worktree'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}
if (process.argv.includes('--history')) {
    // Only the branch being published, not editor checkpoint or stash refs.
    const objects = git(['rev-list', '--objects', 'HEAD']).trim().split('\n');
    for (const entry of objects) {
        const split = entry.indexOf(' ');
        if (split < 0) continue;
        const id = entry.slice(0, split), file = entry.slice(split + 1);
        if (git(['cat-file', '-t', id]).trim() === 'blob') inspect(file, git(['cat-file', 'blob', id]), 'history');
    }
    for (const email of git(['log', '--format=%ae%n%ce', 'HEAD']).trim().split('\n')) {
        if (email && !email.endsWith('@users.noreply.github.com')) {
            console.error('History includes a personal commit email. Value omitted.');
            failed = true;
        }
    }
}
if (failed) process.exitCode = 1;
else console.log('Repository privacy check passed; no private values printed.');
