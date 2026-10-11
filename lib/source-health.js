export function sourceWarning(source, now = Date.now()) {
    const warnings = [];
    if ((source.consecutiveFailures ?? 0) >= 3) warnings.push(`${source.consecutiveFailures} consecutive checks failed`);
    else if (source.error) warnings.push('Latest check failed');
    if (!source.lastSuccessAt) warnings.push('No successful check recorded');
    else if (now - Date.parse(source.lastSuccessAt) > 2 * 60 * 60 * 1000) warnings.push('No successful check in over 2 hours');
    return warnings.join(' · ');
}
