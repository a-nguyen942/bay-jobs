import { cleanText, textKey, tokenKey } from '../lib/text.js';
import { searchPreferences } from '../config/search.js';

export const experienceLevels = ['internship', 'new_grad', 'experienced', 'unspecified'];
export const defaultPreferences = () => ({ locations: [...searchPreferences.locations], includeRemote: false, reviewBroadLocations: false,
    experienceLevels: [...experienceLevels], keywords: [], excludedKeywords: [] });

export async function getPreferences(db) {
    const row = await db.prepare('SELECT preferences FROM search_settings WHERE id = 1').first();
    return row ? validatePreferences({ ...defaultPreferences(), ...JSON.parse(row.preferences) }) : defaultPreferences();
}
export function validatePreferences(body) {
    const keys = ['locations', 'includeRemote', 'experienceLevels', 'keywords', 'excludedKeywords', 'reviewBroadLocations'];
    if (!body || typeof body !== 'object' || Array.isArray(body) || (Object.keys(body).length < keys.length - 1 || Object.keys(body).length > keys.length) ||
        Object.keys(body).some(key => !keys.includes(key)) || typeof body.includeRemote !== 'boolean' || ('reviewBroadLocations' in body && typeof body.reviewBroadLocations !== 'boolean'))
        throw new Error('Provide all search preference fields.');
    body = { ...body };
    for (const [key, choices] of [['locations', searchPreferences.locations], ['experienceLevels', experienceLevels]]) {
        if (Array.isArray(body[key])) body[key] = body[key].map(value => typeof value === 'string'
            ? choices.find(choice => choice === value) ?? choices.find(choice => textKey(choice) === textKey(value)) ?? tokenKey(value) : value);
        if (!Array.isArray(body[key]) || body[key].length > choices.length || body[key].some(value => !choices.includes(value)) ||
            new Set(body[key]).size !== body[key].length) throw new Error(`Invalid ${key}.`);
    }
    if (!body.experienceLevels.length || (!body.locations.length && !body.includeRemote))
        throw new Error('Choose an experience level and at least one city, or include remote roles.');
    const result = { reviewBroadLocations: false, ...body };
    for (const key of ['keywords', 'excludedKeywords']) {
        if (!Array.isArray(body[key]) || body[key].length > 20 || body[key].some(value => typeof value !== 'string' || !value.trim() || value.length > 80))
            throw new Error('Use up to 20 keywords, each between 1 and 80 characters.');
        const words = new Map();
        for (const value of body[key]) {
            const cleaned = cleanText(value);
            if (!textKey(cleaned)) throw new Error('Keywords must contain visible text.');
            if (!words.has(textKey(cleaned))) words.set(textKey(cleaned), cleaned);
        }
        result[key] = [...words.values()];
    }
    return result;
}
export async function preferencesApi(request, db) {
    if (!['GET', 'PATCH'].includes(request.method))
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET, PATCH' } });
    if (request.method === 'PATCH' && request.headers.get('Origin') !== new URL(request.url).origin)
        return Response.json({ error: 'Invalid origin' }, { status: 403 });
    let preferences;
    if (request.method === 'PATCH') {
        try { preferences = validatePreferences(await request.json()); }
        catch (error) { return Response.json({ error: error instanceof SyntaxError ? 'Invalid JSON' : error.message }, { status: 400 }); }
    }
    try {
        if (preferences) await db.prepare('INSERT INTO search_settings VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET preferences = excluded.preferences')
            .bind(JSON.stringify(preferences)).run();
        return Response.json({ preferences: preferences ?? await getPreferences(db), locations: searchPreferences.locations,
            experienceLevels }, { headers: { 'Cache-Control': 'no-store' } });
    } catch {
        return Response.json({ error: 'Search preferences unavailable. Check the database migrations.' }, { status: 503 });
    }
}
