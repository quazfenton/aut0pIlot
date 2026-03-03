import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConfigLoader } from '../../scripts/config-loader';

describe('ConfigLoader', () => {
  let loader: ConfigLoader;
  let mockOctokit: any;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        repos: {
          getContent: vi.fn(),
        },
      },
    };
    loader = new ConfigLoader(mockOctokit);
  });

  describe('loadConfig', () => {
    it('should load config from repository', async () => {
      const configYaml = `
autofix:
  enabled: true
  max_iterations: 10
  allowed_bots:
    - coderabbitai
  risk_level: high
  branch_strategy: helper_pr
  require_approval_for_risky: true
`;

      mockOctokit.rest.repos.getContent.mockResolvedValue({
        status: 200,
        data: {
          content: Buffer.from(configYaml).toString('base64'),
        },
      });

      const config = await loader.loadConfig('owner', 'repo');

      expect(config.autofix.enabled).toBe(true);
      expect(config.autofix.max_iterations).toBe(10);
      expect(config.autofix.allowed_bots).toContain('coderabbitai');
      expect(config.autofix.risk_level).toBe('high');
    });

    it('should return default config when not found', async () => {
      mockOctokit.rest.repos.getContent.mockRejectedValue({ status: 404 });

      const config = await loader.loadConfig('owner', 'repo');

      expect(config.autofix.enabled).toBe(true);
      expect(config.autofix.max_iterations).toBe(5);
    });

    it('should cache loaded config', async () => {
      mockOctokit.rest.repos.getContent.mockResolvedValue({
        status: 200,
        data: {
          content: Buffer.from('autofix:\n  enabled: false').toString('base64'),
        },
      });

      await loader.loadConfig('owner', 'repo');
      await loader.loadConfig('owner', 'repo');

      expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledTimes(1);
    });

    it('should merge with defaults', async () => {
      const partialConfig = `
autofix:
  enabled: false
`;

      mockOctokit.rest.repos.getContent.mockResolvedValue({
        status: 200,
        data: {
          content: Buffer.from(partialConfig).toString('base64'),
        },
      });

      const config = await loader.loadConfig('owner', 'repo');

      expect(config.autofix.enabled).toBe(false);
      expect(config.autofix.max_iterations).toBe(5); // Default
      expect(config.autofix.allowed_bots).toBeDefined(); // Default
    });

    it('should handle bot_settings', async () => {
      const configWithBotSettings = `
autofix:
  enabled: true
bot_settings:
  coderabbitai:
    process_all: true
    auto_apply_suggestions: true
`;

      mockOctokit.rest.repos.getContent.mockResolvedValue({
        status: 200,
        data: {
          content: Buffer.from(configWithBotSettings).toString('base64'),
        },
      });

      const config = await loader.loadConfig('owner', 'repo');

      expect(config.bot_settings).toBeDefined();
      expect(config.bot_settings?.coderabbitai?.process_all).toBe(true);
    });

    it('should handle exclude_paths', async () => {
      const configWithExcludes = `
autofix:
  enabled: true
exclude_paths:
  - '.github/'
  - '*.md'
  - 'docs/'
`;

      mockOctokit.rest.repos.getContent.mockResolvedValue({
        status: 200,
        data: {
          content: Buffer.from(configWithExcludes).toString('base64'),
        },
      });

      const config = await loader.loadConfig('owner', 'repo');

      expect(config.exclude_paths).toBeDefined();
      expect(config.exclude_paths).toContain('.github/');
      expect(config.exclude_paths).toContain('*.md');
    });
  });

  describe('clearCache', () => {
    it('should clear cached config', async () => {
      mockOctokit.rest.repos.getContent.mockResolvedValue({
        status: 200,
        data: {
          content: Buffer.from('autofix:\n  enabled: true').toString('base64'),
        },
      });

      await loader.loadConfig('owner', 'repo');
      loader.clearCache();
      await loader.loadConfig('owner', 'repo');

      expect(mockOctokit.rest.repos.getContent).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('should handle non-404 errors', async () => {
      mockOctokit.rest.repos.getContent.mockRejectedValue({
        status: 500,
        message: 'Server error',
      });

      const config = await loader.loadConfig('owner', 'repo');

      // Should fall back to defaults
      expect(config).toBeDefined();
      expect(config.autofix.enabled).toBe(true);
    });

    it('should handle malformed YAML', async () => {
      mockOctokit.rest.repos.getContent.mockResolvedValue({
        status: 200,
        data: {
          content: Buffer.from('invalid: yaml: content: [').toString('base64'),
        },
      });

      // Should not throw, fall back to defaults
      const config = await loader.loadConfig('owner', 'repo');
      expect(config).toBeDefined();
    });
  });
});
