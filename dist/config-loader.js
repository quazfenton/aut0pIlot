import * as yaml from 'js-yaml';
const DEFAULT_CONFIG = {
    autofix: {
        enabled: true,
        max_iterations: 5,
        allowed_bots: ['coderabbitai', 'cubic-dev-ai', 'coderabbit'],
        risk_level: 'medium',
        branch_strategy: 'update_same_pr',
        require_approval_for_risky: true,
    },
    exclude_paths: ['.github/', '*.md', 'package-lock.json', 'yarn.lock'],
    bot_settings: {
        coderabbitai: {
            process_all: true,
            auto_apply_suggestions: true,
        },
        'cubic-dev-ai': {
            process_all: true,
            auto_apply_suggestions: true,
        },
        coderabbit: {
            process_all: true,
            auto_apply_suggestions: true,
        },
    },
};
export class ConfigLoader {
    cache = new Map();
    gitHub; // Octokit instance
    constructor(gitHub) {
        this.gitHub = gitHub;
    }
    async loadConfig(owner, repo) {
        const cacheKey = `${owner}/${repo}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey);
        }
        try {
            const response = await this.gitHub.rest.repos.getContent({
                owner,
                repo,
                path: '.pr-agent.yml',
            });
            if (response.status === 200 && 'content' in response.data) {
                const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
                const config = yaml.load(content);
                const mergedConfig = this.mergeWithDefaults(config);
                this.cache.set(cacheKey, mergedConfig);
                return mergedConfig;
            }
        }
        catch (error) {
            if (error.status !== 404) {
                console.error(`Failed to load config for ${owner}/${repo}:`, error.message);
            }
        }
        // Use defaults if no config found
        this.cache.set(cacheKey, { ...DEFAULT_CONFIG });
        return { ...DEFAULT_CONFIG };
    }
    mergeWithDefaults(config) {
        return {
            autofix: {
                ...DEFAULT_CONFIG.autofix,
                ...(config.autofix || {}),
            },
            exclude_paths: config.exclude_paths || DEFAULT_CONFIG.exclude_paths,
            bot_settings: {
                ...DEFAULT_CONFIG.bot_settings,
                ...(config.bot_settings || {}),
            },
        };
    }
    clearCache() {
        this.cache.clear();
    }
}
