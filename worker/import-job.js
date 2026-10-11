import { cleanText, listingText, textKey } from '../lib/text.js';
import { skillMask } from '../lib/skills.js';
import { canonicalizeUrl, experienceLevel } from '../lib/matching.js';
import { JOB_COLUMNS, toJob } from '../db/jobs.js';

function parseListing(body) {
    const limits = { url: 2048, title: 200, company: 200, location: 300 };
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !Object.hasOwn(limits, key))) {
        throw new Error('Provide a listing URL, role, company, and location.');
    }
    const listing = {};
    for (const [key, limit] of Object.entries(limits)) {
        if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > limit)
            throw new Error(`Provide a valid ${key} (up to ${limit} characters).`);
        listing[key] = key === 'url' ? body[key].trim() : cleanText(body[key]);
        if (!listing[key]) throw new Error(`Provide a valid ${key}.`);
    }
    const url = new URL(canonicalizeUrl(listing.url));
    let sourceLabel = 'Manual link';
    if (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) {
        const match = /^\/(?:comm\/)?jobs\/view\/(?:[^/]*-)?(\d+)\/?$/.exec(url.pathname);
        if (!match) throw new Error('Use the LinkedIn listing link containing /jobs/view/ and a job ID.');
        listing.url = `https://www.linkedin.com/jobs/view/${match[1]}`;
        sourceLabel = 'LinkedIn · Manual';
    } else if (url.hostname === 'joinhandshake.com' || url.hostname.endsWith('.joinhandshake.com')) {
        const match = /^\/(?:stu\/)?jobs\/(\d+)\/?$/.exec(url.pathname);
        if (!match) throw new Error('Use the Handshake listing link containing /jobs/ and a job ID.');
        listing.url = `https://app.joinhandshake.com/stu/jobs/${match[1]}`;
        sourceLabel = 'Handshake · Manual';
    } else {
        listing.url = url.toString();
    }
    return { ...listing, sourceLabel };
}

export async function importJob(request, db) {
    if (request.headers.get('Origin') !== new URL(request.url).origin)
        return Response.json({ error: 'Invalid origin' }, { status: 403 });
    let listing;
    try {
        listing = parseListing(await request.json());
    } catch (error) {
        return Response.json({ error: error instanceof SyntaxError ? 'Invalid JSON' : error.message }, { status: 400 });
    }
    try {
        const now = new Date().toISOString();
        // Explicitly saved listings bypass discovery filters and are already seen.
        // A repeated save preserves every existing field and never queues an email.
        const [insert, saved] = await db.batch([
            db.prepare(`INSERT INTO jobs (id, canonical_url, title, company, location, source_label,
                first_found_at, last_seen_at, seen_at, skill_mask, search_text, title_key, is_intern)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(canonical_url) DO NOTHING RETURNING id`)
                .bind(crypto.randomUUID(), listing.url, listing.title, listing.company, listing.location,
                    listing.sourceLabel, now, now, now, skillMask(listing.title), listingText(listing), textKey(listing.title), Number(experienceLevel(listing) === 'internship')),
            db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE canonical_url = ?`).bind(listing.url),
        ]);
        const created = insert.results.length > 0;
        return Response.json({ job: toJob(saved.results[0]), created }, {
            status: created ? 201 : 200, headers: { 'Cache-Control': 'no-store' },
        });
    } catch {
        return Response.json({ error: 'Could not save the listing. Check the database and try again.' }, { status: 503 });
    }
}
