import { decodeHTML } from 'entities';

// Natural-language fields only. Never use these helpers on IDs, URL paths,
// credentials, object keys, or other case-sensitive protocol values.
export function cleanText(value) {
    return value.normalize('NFC').replace(/[\u00ad\u200b\u2060\ufeff]/g, '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
        .replace(/\s+/gu, ' ').trim();
}
export function plainText(value) {
    // Some feeds escape their HTML once more. Bound decoding work to two passes.
    let text = value;
    for (let i = 0; i < 2; i++) {
        const decoded = decodeHTML(text);
        if (decoded === text) break;
        text = decoded;
    }
    return cleanText(text.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
        .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|table|tr|td|th|section|article|hr)\b[^>]*>/gi, ' ').replace(/<[^>]*>/g, ''));
}
export function textKey(value) {
    return cleanText(value).normalize('NFKD').replace(/\p{M}/gu, '')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/\s*-\s*/g, '-').replace(/[\u2018\u2019\u02bc]/g, "'")
        .replace(/[\u201c\u201d]/g, '"').replace(/\s+/gu, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}
export const tokenKey = value => typeof value === 'string' ? textKey(value) : value;
export const searchKey = value => textKey(value).replace(/[.,;:|()[\]{}"'!?/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
export const listingText = job => searchKey(`${job.title} ${job.company} ${job.location}`);
export function normalizeListing(job) {
    if (!job || !['title', 'company', 'location', 'url'].every(key => typeof job[key] === 'string'))
        throw new Error('Source listing format changed or required text fields are missing');
    const result = { ...job, title: plainText(job.title), company: plainText(job.company), location: plainText(job.location) };
    if (!result.title || !result.company) throw new Error('Source listing has empty required text fields');
    return result;
}
export function emailAddress(value) {
    if (typeof value !== 'string') return value;
    // Preserve the mailbox's case; only the domain is case-insensitive.
    const trimmed = value.trim();
    const at = trimmed.lastIndexOf('@');
    return at < 0 ? trimmed : trimmed.slice(0, at + 1) + trimmed.slice(at + 1).toLowerCase();
}
