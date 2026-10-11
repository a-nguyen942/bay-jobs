import { publicBoardSource } from './public-boards.js';
import { conditionalSource } from './conditional.js';
import { greenhouseSource } from './greenhouse.js';
import { githubSource } from './github.js';
import { ashbySource } from './ashby.js';
import { leverSource } from './lever.js';

export function createSources(configs, request = fetch) {
    return configs.map(config => {
        if (['wellfound', 'yc'].includes(config.kind)) return publicBoardSource(config, request);
        if (config.kind === 'greenhouse') return conditionalSource(greenhouseSource, config, request);
        if (config.kind === 'github') return conditionalSource(githubSource, config, request);
        if (config.kind === 'ashby') return conditionalSource(ashbySource, config, request);
        if (config.kind === 'lever') return leverSource(config, request);
        return { id: config.id, label: config.id, async fetchListings() { throw new Error('Unsupported job source kind'); } };
    });
}
