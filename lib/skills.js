import { plainText, textKey } from './text.js';
// Tags describe mentions, not guaranteed requirements or candidate eligibility.
export const SKILLS = [
    { id: 'javascript', label: 'JavaScript / TypeScript', bit: 1, pattern: /\b(?:javascript|js|typescript|node\.?js)\b/i },
    { id: 'python', label: 'Python', bit: 2, pattern: /\bpython\b/i },
    { id: 'cpp', label: 'C++', bit: 4, pattern: /(?:^|[^a-z0-9_])c\s*\+\s*\+(?![a-z0-9_+])/i },
    { id: 'html', label: 'HTML', bit: 8, pattern: /\bhtml5?\b/i },
    { id: 'css', label: 'CSS', bit: 16, pattern: /\b(?:css3?|sass|scss|tailwind(?:css)?)\b/i },
    { id: 'frameworks', label: 'Web frameworks', bit: 32, pattern: /\b(?:react(?:js)?|next\.?js|vue(?:\.js|js)?|nuxt(?:\.js)?|angular(?:js)?|svelte|django|flask|fastapi|express(?:\.js|js)?|bootstrap|tailwind(?:css)?)\b/i },
];
export const ALL_SKILLS = SKILLS.reduce((mask, skill) => mask | skill.bit, 0);
export function skillMask(title, description = '') {
    const text = textKey(plainText(`${title} ${description}`));
    return SKILLS.reduce((mask, skill) => skill.pattern.test(text) ? mask | skill.bit : mask, 0);
}
