import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewParser } from '../../scripts/review-parser';
import { PRConfig } from '../../scripts/types';

describe('ReviewParser', () => {
  let parser: ReviewParser;

  beforeEach(() => {
    parser = new ReviewParser();
  });

  describe('parseInlineComment', () => {
    it('should parse a basic inline comment', () => {
      const event = {
        comment: {
          id: 123,
          path: 'src/test.ts',
          line: 10,
          start_line: 10,
          end_line: 10,
          body: 'This is a review comment',
          user: { login: 'reviewer' },
          commit_id: 'abc123',
          diff_hunk: '@@ -5,5 +5,5 @@ context',
          html_url: 'https://github.com/test/repo/pull/1#discussion-123',
        },
        pull_request: {
          head: { sha: 'def456' },
        },
      };

      const result = parser.parseInlineComment(event);

      expect(result).not.toBeNull();
      expect(result?.id).toBe('123');
      expect(result?.file).toBe('src/test.ts');
      expect(result?.start_line).toBe(10);
      expect(result?.end_line).toBe(10);
      expect(result?.type).toBe('inline_comment');
      expect(result?.author).toBe('reviewer');
    });

    it('should parse a suggestion block', () => {
      const event = {
        comment: {
          id: 124,
          path: 'src/test.ts',
          line: 5,
          start_line: 5,
          end_line: 5,
          body: 'Consider this change:\n\n```suggestion\nconst x = 2;\n```',
          user: { login: 'reviewer' },
          commit_id: 'abc123',
          diff_hunk: '@@ -3,3 +3,3 @@ context',
          html_url: 'https://github.com/test/repo/pull/1#discussion-124',
        },
        pull_request: {
          head: { sha: 'def456' },
        },
      };

      const result = parser.parseInlineComment(event);

      expect(result).not.toBeNull();
      expect(result?.type).toBe('suggested_change');
      expect(result?.suggestions).toBeDefined();
      expect(result?.suggestions).toHaveLength(1);
      expect(result?.suggestions?.[0].code).toBe('const x = 2;');
    });

    it('should extract CodeRabbit proposed fix', () => {
      const event = {
        comment: {
          id: 125,
          path: 'src/test.ts',
          line: 15,
          start_line: 10,
          end_line: 15,
          body: `**Proposed fix:**
\`\`\`typescript
const fixed = true;
\`\`\`

Some explanation here.`,
          user: { login: 'coderabbitai[bot]' },
          commit_id: 'abc123',
          diff_hunk: '@@ -10,6 +10,6 @@ context',
          html_url: 'https://github.com/test/repo/pull/1#discussion-125',
        },
        pull_request: {
          head: { sha: 'def456' },
        },
      };

      const result = parser.parseInlineComment(event);

      expect(result).not.toBeNull();
      expect(result?.proposed_fixes).toBeDefined();
      expect(result?.proposed_fixes).toHaveLength(1);
    });

    it('should extract agent prompt', () => {
      const event = {
        comment: {
          id: 126,
          path: 'src/test.ts',
          line: 20,
          start_line: 20,
          end_line: 20,
          body: `**Prompt for AI Agents:**
Please fix this by adding error handling and validation.
Make sure to check for null values.`,
          user: { login: 'reviewer' },
          commit_id: 'abc123',
          diff_hunk: '@@ -20,1 +20,1 @@ context',
          html_url: 'https://github.com/test/repo/pull/1#discussion-126',
        },
        pull_request: {
          head: { sha: 'def456' },
        },
      };

      const result = parser.parseInlineComment(event);

      expect(result).not.toBeNull();
      expect(result?.agent_prompt).toBeDefined();
      expect(result?.agent_prompt).toContain('error handling');
    });

    it('should return null for missing comment', () => {
      const event = {
        comment: null,
        pull_request: { head: { sha: 'abc' } },
      };

      const result = parser.parseInlineComment(event);
      expect(result).toBeNull();
    });

    it('should return null for missing pull_request', () => {
      const event = {
        comment: { id: 1, path: 'test.ts' },
        pull_request: null,
      };

      const result = parser.parseInlineComment(event);
      expect(result).toBeNull();
    });
  });

  describe('parseReview', () => {
    it('should parse a bot review', () => {
      const event = {
        review: {
          user: { login: 'coderabbitai[bot]', type: 'Bot' },
          body: 'Review summary here',
          commit_id: 'abc123',
          comments: [
            {
              id: 201,
              path: 'src/test.ts',
              line: 5,
              start_line: 5,
              end_line: 5,
              body: 'Issue here',
              diff_hunk: '@@ -5,1 +5,1 @@',
              html_url: 'https://github.com/test/repo/pull/1#discussion-201',
            },
          ],
        },
        pull_request: {
          head: { sha: 'def456', repo: { full_name: 'test/repo' } },
          number: 1,
        },
      };

      const results = parser.parseReview(event);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].bot_name).toBe('coderabbitai');
    });

    it('should parse human review', () => {
      const event = {
        review: {
          user: { login: 'human-reviewer', type: 'User' },
          body: 'Great work!',
          commit_id: 'abc123',
          comments: [],
        },
        pull_request: {
          head: { sha: 'def456', repo: { full_name: 'test/repo' } },
          number: 1,
        },
      };

      const results = parser.parseReview(event);
      expect(results).toBeDefined();
    });

    it('should return empty array for missing review', () => {
      const event = {
        review: null,
        pull_request: { head: { sha: 'abc' } },
      };

      const results = parser.parseReview(event);
      expect(results).toEqual([]);
    });
  });

  describe('extractStructuredContent', () => {
    it('should extract GitHub suggestion', () => {
      const body = `Here's my suggestion:

\`\`\`suggestion
const improved = true;
\`\`\`

Let me know what you think.`;

      const { suggestions, proposed_fixes, agent_prompt } = parser.extractStructuredContent(body);

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].code).toBe('const improved = true;');
      expect(suggestions[0].source).toBe('github');
    });

    it('should extract multiple suggestions', () => {
      const body = `\`\`\`suggestion
const a = 1;
\`\`\`

And another:

\`\`\`suggestion
const b = 2;
\`\`\``;

      const { suggestions } = parser.extractStructuredContent(body);

      expect(suggestions).toHaveLength(2);
    });

    it('should extract CodeRabbit committable suggestion', () => {
      const body = `**Committable suggestion:**

\`\`\`suggestion
const fixed = true;
\`\`\``;

      const { suggestions } = parser.extractStructuredContent(body);

      expect(suggestions.length).toBeGreaterThan(0);
    });

    it('should extract proposed fix section', () => {
      const body = `**Proposed fix:**

\`\`\`typescript
function fixed() {
  return true;
}
\`\`\``;

      const { proposed_fixes } = parser.extractStructuredContent(body);

      expect(proposed_fixes).toHaveLength(1);
      expect(proposed_fixes[0]).toContain('function fixed');
    });

    it('should extract agent prompt section', () => {
      const body = `**Prompt for AI Agents:**
Fix the authentication logic to handle expired tokens properly.
Add retry logic for transient failures.`;

      const { agent_prompt } = parser.extractStructuredContent(body);

      expect(agent_prompt).toContain('authentication logic');
      expect(agent_prompt).toContain('expired tokens');
    });

    it('should handle empty body', () => {
      const { suggestions, proposed_fixes, agent_prompt } = parser.extractStructuredContent('');

      expect(suggestions).toEqual([]);
      expect(proposed_fixes).toEqual([]);
      expect(agent_prompt).toBe('');
    });
  });

  describe('filterComments', () => {
    const defaultConfig: PRConfig = {
      autofix: {
        enabled: true,
        max_iterations: 5,
        allowed_bots: ['coderabbitai', 'coderabbit'],
        risk_level: 'medium',
        branch_strategy: 'update_same_pr',
        require_approval_for_risky: true,
      },
    };

    it('should filter bot comments by whitelist', () => {
      const comments = [
        { id: '1', author: 'coderabbitai[bot]', bot_name: 'coderabbitai', type: 'bot_review' as const, file: 'test.ts', start_line: 1, end_line: 1, content: '', commit_sha: '' },
        { id: '2', author: 'unknown-bot[bot]', bot_name: 'unknown-bot', type: 'bot_review' as const, file: 'test.ts', start_line: 2, end_line: 2, content: '', commit_sha: '' },
      ];

      const filtered = parser.filterComments(comments, defaultConfig);

      expect(filtered).toHaveLength(1);
      expect(filtered[0].author).toBe('coderabbitai[bot]');
    });

    it('should allow human comments', () => {
      const comments = [
        { id: '1', author: 'human-reviewer', type: 'inline_comment' as const, file: 'test.ts', start_line: 1, end_line: 1, content: '', commit_sha: '' },
      ];

      const filtered = parser.filterComments(comments, defaultConfig);

      expect(filtered).toHaveLength(1);
    });

    it('should return empty when autofix disabled', () => {
      const config: PRConfig = {
        ...defaultConfig,
        autofix: { ...defaultConfig.autofix, enabled: false },
      };

      const comments = [
        { id: '1', author: 'human', type: 'inline_comment' as const, file: 'test.ts', start_line: 1, end_line: 1, content: '', commit_sha: '' },
      ];

      const filtered = parser.filterComments(comments, config);

      expect(filtered).toHaveLength(0);
    });

    it('should normalize bot names for matching', () => {
      const config: PRConfig = {
        autofix: {
          enabled: true,
          max_iterations: 5,
          allowed_bots: ['coderabbitai'], // Without [bot] suffix
          risk_level: 'medium',
          branch_strategy: 'update_same_pr',
          require_approval_for_risky: true,
        },
      };

      const comments = [
        { id: '1', author: 'coderabbitai[bot]', bot_name: 'coderabbitai', type: 'bot_review' as const, file: 'test.ts', start_line: 1, end_line: 1, content: '', commit_sha: '' },
      ];

      const filtered = parser.filterComments(comments, config);

      expect(filtered).toHaveLength(1);
    });
  });

  describe('requiresApproval', () => {
    it('should require approval for security keywords', () => {
      const comment = {
        id: '1',
        file: 'auth.ts',
        start_line: 1,
        end_line: 1,
        type: 'inline_comment' as const,
        content: 'This has a security vulnerability',
        author: 'reviewer',
        commit_sha: 'abc',
      };

      const requires = parser.requiresApproval(comment, 'low');
      expect(requires).toBe(true);
    });

    it('should require approval for breaking changes', () => {
      const comment = {
        id: '1',
        file: 'api.ts',
        start_line: 1,
        end_line: 1,
        type: 'inline_comment' as const,
        content: 'This is a breaking change to the API',
        author: 'reviewer',
        commit_sha: 'abc',
      };

      const requires = parser.requiresApproval(comment, 'low');
      expect(requires).toBe(true);
    });

    it('should not require approval for suggested changes at medium risk', () => {
      const comment = {
        id: '1',
        file: 'utils.ts',
        start_line: 1,
        end_line: 1,
        type: 'suggested_change' as const,
        content: 'Minor improvement',
        author: 'reviewer',
        commit_sha: 'abc',
      };

      const requires = parser.requiresApproval(comment, 'medium');
      expect(requires).toBe(false);
    });
  });
});
