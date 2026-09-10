/** Starting defaults; experience level is deliberately unrestricted. */
export const searchPreferences = {
    locations: [
        'San Francisco', 'San Jose', 'San José', 'Bay Area', 'South San Francisco',
        'Daly City', 'San Bruno', 'Millbrae', 'Burlingame', 'San Mateo', 'Foster City',
        'Belmont', 'San Carlos', 'Redwood City', 'Menlo Park', 'Palo Alto',
        'Mountain View', 'Sunnyvale', 'Santa Clara', 'Cupertino', 'Milpitas',
        'Campbell', 'Los Gatos', 'Saratoga', 'Fremont', 'Newark', 'Union City',
        'Hayward', 'Oakland', 'Berkeley', 'Emeryville',
    ],
    // Match technical job functions, not a standalone mention of "software" or "developer".
    rolePattern: /\b(swe|software\s+(engineer(?:ing)?|developer|intern)|(?:front[ -]?end|back[ -]?end|full[ -]?stack|web|mobile|ios|android|data|platform|infrastructure|security|qa|test|devops|machine learning|ml|ai|forward deployed|site reliability)\s+(engineer(?:ing)?|developer)|(?:machine learning|ml|ai)\s+(research\s+)?scientist|sdet)\b/i,
    excludedRolePattern: /\b(sales|recruiter|recruiting|marketing|business develop(?:er|ment)|developer (relations|advocate|advocacy)|product manag(?:er|ement)|technical writer)\b/i,
    includeRemote: false,
};
