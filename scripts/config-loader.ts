import * as yaml from 'js-yaml';

export interface PRConfig {
  autofix: {
    enabled: boolean;
    max_iterations: number;
    allowed_bots: string[];
    risk_level: 'low' | 'medium' | 'high';
    branch_strategy: 'update_same_pr' | 'helper_pr';
    require_approval_for_risky: boolean;
  };
  exclude_paths?: string[];
  bot_settings?: Record<string, {
    process_all?: boolean;
    auto_apply_suggestions?: boolean;
  }>;
}

//'coderabbitai', 'cubic-dev-ai', 'coderabbit', 'sourcery-ai', 'greptileapps', 'codeant-ai', 'gitar-bot', 'graphite-app', 'qodocodereview'
const DEFAULT_CONFIG: PRConfig = {
  autofix: {
    enabled: true,
    max_iterations: 5,
    allowed_bots: ['coderabbitai', 'cubic-dev-ai', 'coderabbit', 'sourcery-ai', 'greptileapps', 'codeant-ai'],
    risk_level: 'medium',
    branch_strategy: 'helper_pr',  // Default to helper branch for safety
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
  private cache: Map<string, PRConfig> = new Map();
  private gitHub: any; // Octokit instance

  constructor(gitHub: any) {
    this.gitHub = gitHub;
  }

  async loadConfig(owner: string, repo: string): Promise<PRConfig> {
    const cacheKey = `${owner}/${repo}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    try {
      const response = await this.gitHub.rest.repos.getContent({
        owner,
        repo,
        path: '.pr-agent.yml',
      });

      if (response.status === 200 && 'content' in response.data) {
        const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
        const config = yaml.load(content) as PRConfig;
        const mergedConfig = this.mergeWithDefaults(config);
        this.cache.set(cacheKey, mergedConfig);
        return mergedConfig;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        console.error(`Failed to load config for ${owner}/${repo}:`, error.message);
      }
    }

    // Use defaults if no config found
    this.cache.set(cacheKey, { ...DEFAULT_CONFIG });
    return { ...DEFAULT_CONFIG };
  }

  private mergeWithDefaults(config: any): PRConfig {
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

  clearCache(): void {
    this.cache.clear();
  }
}
