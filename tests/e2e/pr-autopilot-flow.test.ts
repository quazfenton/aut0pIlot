import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GitOps } from '../../scripts/git-ops';
import { PatchGenerator } from '../../scripts/patch-generator';
import { ReviewParser, ParsedReviewComment } from '../../scripts/review-parser';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * E2E Test Framework for PR Autopilot
 * 
 * This framework tests the complete flow from review comment to patch application
 */

interface E2ETestContext {
  tempDir: string;
  repoDir: string;
  gitOps: GitOps;
  parser: ReviewParser;
  generator: PatchGenerator;
}

interface MockReviewComment {
  file: string;
  startLine: number;
  endLine: number;
  content: string;
  suggestions?: Array<{ code: string; source: string }>;
  expectedChange: string;
}

interface E2ETestResult {
  success: boolean;
  patch?: string;
  appliedContent?: string;
  errors?: string[];
  qualityScore?: number;
}

describe('E2E - PR Autopilot Full Flow', () => {
  let ctx: E2ETestContext;

  beforeEach(async () => {
    ctx = await setupTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  describe('Simple Variable Rename', () => {
    it('should handle basic variable rename suggestion', async () => {
      const comment: MockReviewComment = {
        file: 'src/utils.ts',
        startLine: 5,
        endLine: 5,
        content: 'Use more descriptive variable name',
        suggestions: [{ code: 'const userName = "John";', source: 'github' }],
        expectedChange: 'const userName = "John";'
      };

      const result = await runE2ETest(ctx, comment);

      expect(result.success).toBe(true);
      expect(result.patch).toBeDefined();
      expect(result.patch).toContain('userName');
    });
  });

  describe('Function Refactoring', () => {
    it('should handle function extraction suggestion', async () => {
      const comment: MockReviewComment = {
        file: 'src/calculator.ts',
        startLine: 10,
        endLine: 20,
        content: 'Extract this logic into a separate function',
        suggestions: [{
          code: `function calculateTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}`,
          source: 'github'
        }],
        expectedChange: 'function calculateTotal'
      };

      const result = await runE2ETest(ctx, comment);

      expect(result.success).toBe(true);
      expect(result.patch).toContain('calculateTotal');
    });
  });

  describe('Bug Fix', () => {
    it('should handle off-by-one error fix', async () => {
      const comment: MockReviewComment = {
        file: 'src/array-utils.ts',
        startLine: 15,
        endLine: 15,
        content: 'Off-by-one error: should be < instead of <=',
        suggestions: [{ code: 'for (let i = 0; i < arr.length; i++) {', source: 'github' }],
        expectedChange: 'i < arr.length'
      };

      const result = await runE2ETest(ctx, comment);

      expect(result.success).toBe(true);
      expect(result.patch).toContain('< arr.length');
    });
  });

  describe('Type Safety', () => {
    it('should handle type annotation addition', async () => {
      const comment: MockReviewComment = {
        file: 'src/types.ts',
        startLine: 8,
        endLine: 8,
        content: 'Add explicit type annotation',
        suggestions: [{ code: 'const data: UserData = {', source: 'github' }],
        expectedChange: ': UserData'
      };

      const result = await runE2ETest(ctx, comment);

      expect(result.success).toBe(true);
      expect(result.patch).toContain(': UserData');
    });
  });

  describe('Error Handling', () => {
    it('should handle try-catch addition', async () => {
      const comment: MockReviewComment = {
        file: 'src/api.ts',
        startLine: 25,
        endLine: 30,
        content: 'Add error handling for this async operation',
        suggestions: [{
          code: `try {
  const response = await fetch(url);
  return await response.json();
} catch (error) {
  console.error('Fetch failed:', error);
  throw error;
}`,
          source: 'github'
        }],
        expectedChange: 'try'
      };

      const result = await runE2ETest(ctx, comment);

      expect(result.success).toBe(true);
      expect(result.patch).toContain('try');
      expect(result.patch).toContain('catch');
    });
  });
});

describe('E2E - Multi-File Changes', () => {
  let ctx: E2ETestContext;

  beforeEach(async () => {
    ctx = await setupTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it('should handle changes requiring import updates', async () => {
    // Setup: Create files with cross-file dependencies
    await createTestFile(ctx, 'src/types.ts', `export interface User {
  id: number;
  name: string;
}`);

    await createTestFile(ctx, 'src/utils.ts', `import { User } from './types';

export function createUser(name: string): User {
  return { id: 1, name };
}`);

    const comment: MockReviewComment = {
      file: 'src/types.ts',
      startLine: 2,
      endLine: 5,
      content: 'Add email field to User interface',
      suggestions: [{
        code: `export interface User {
  id: number;
  name: string;
  email: string;
}`,
        source: 'github'
      }],
      expectedChange: 'email: string'
    };

    const result = await runE2ETest(ctx, comment);

    expect(result.success).toBe(true);
    expect(result.patch).toContain('email');
  });
});

describe('E2E - Edge Cases', () => {
  let ctx: E2ETestContext;

  beforeEach(async () => {
    ctx = await setupTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  it('should handle empty file creation', async () => {
    const comment: MockReviewComment = {
      file: 'src/new-module.ts',
      startLine: 1,
      endLine: 1,
      content: 'Create new module file',
      suggestions: [{
        code: `export const VERSION = '1.0.0';

export function init() {
  console.log('Module initialized');
}`,
        source: 'github'
      }],
      expectedChange: 'VERSION'
    };

    const result = await runE2ETest(ctx, comment);

    expect(result.success).toBe(true);
    expect(result.patch).toContain('VERSION');
  });

  it('should handle large file modifications', async () => {
    // Create a large file (1000+ lines)
    let largeContent = '';
    for (let i = 0; i < 1000; i++) {
      largeContent += `const item${i} = ${i};\n`;
    }

    await createTestFile(ctx, 'src/large.ts', largeContent);

    const comment: MockReviewComment = {
      file: 'src/large.ts',
      startLine: 500,
      endLine: 500,
      content: 'Update this constant',
      suggestions: [{ code: 'const item500 = 999;', source: 'github' }],
      expectedChange: 'item500 = 999'
    };

    const result = await runE2ETest(ctx, comment);

    expect(result.success).toBe(true);
    expect(result.patch).toContain('item500');
  });

  it('should handle unicode and special characters', async () => {
    const comment: MockReviewComment = {
      file: 'src/i18n.ts',
      startLine: 5,
      endLine: 10,
      content: 'Add international messages',
      suggestions: [{
        code: `const messages = {
  greeting: 'Hello! 👋',
  farewell: 'Goodbye! 👋',
  success: 'Success! ✅',
  error: 'Error! ❌'
};`,
        source: 'github'
      }],
      expectedChange: '👋'
    };

    const result = await runE2ETest(ctx, comment);

    expect(result.success).toBe(true);
    expect(result.patch).toContain('👋');
  });
});

// Helper Functions

async function setupTestContext(): Promise<E2ETestContext> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-test-'));
  const repoDir = path.join(tempDir, 'test-repo');

  // Create test repo structure
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });

  // Initialize git repo
  const { execSync } = require('child_process');
  execSync('git init', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });

  // Create initial commit
  const readmePath = path.join(repoDir, 'README.md');
  fs.writeFileSync(readmePath, '# Test Repo\n');
  execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
  execSync('git commit -m "initial"', { cwd: repoDir, stdio: 'ignore' });

  return {
    tempDir,
    repoDir,
    gitOps: new GitOps(process.env.GITHUB_TOKEN || 'fake'),
    parser: new ReviewParser(),
    generator: new PatchGenerator()
  };
}

function cleanupTestContext(ctx: E2ETestContext): void {
  try {
    ctx.generator.cleanup();
    ctx.gitOps.cleanup();
    fs.rmSync(ctx.tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

async function createTestFile(ctx: E2ETestContext, filePath: string, content: string): Promise<void> {
  const fullPath = path.join(ctx.repoDir, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);

  // Commit the file
  const { execSync } = require('child_process');
  execSync('git add .', { cwd: ctx.repoDir, stdio: 'ignore' });
  execSync('git commit -m "add ' + filePath + '"', { cwd: ctx.repoDir, stdio: 'ignore' });
}

async function runE2ETest(ctx: E2ETestContext, comment: MockReviewComment): Promise<E2ETestResult> {
  try {
    // Get current commit SHA
    const { execSync } = require('child_process');
    const commitSha = execSync('git rev-parse HEAD', {
      cwd: ctx.repoDir,
      encoding: 'utf-8'
    }).trim();

    // Create patch request
    const patchRequest = {
      repo: 'test/repo',
      pr: 1,
      commit_sha: commitSha,
      file: comment.file,
      start_line: comment.startLine,
      end_line: comment.endLine,
      content: comment.content,
      suggestions: comment.suggestions
    };

    // Generate patch
    const result = await ctx.generator.generatePatch(patchRequest, 2, false);

    if (!result.success || !result.patch) {
      return {
        success: false,
        errors: [result.error || 'Patch generation failed']
      };
    }

    // Apply patch
    const patchFile = path.join(ctx.tempDir, 'test.patch');
    fs.writeFileSync(patchFile, result.patch);

    try {
      execSync(`git apply "${patchFile}"`, {
        cwd: ctx.repoDir,
        stdio: 'ignore'
      });

      // Verify the change was applied
      const filePath = path.join(ctx.repoDir, comment.file);
      const appliedContent = fs.readFileSync(filePath, 'utf-8');

      return {
        success: true,
        patch: result.patch,
        appliedContent,
        qualityScore: calculatePatchQuality(result.patch, comment.expectedChange)
      };
    } catch (error: any) {
      return {
        success: false,
        patch: result.patch,
        errors: [`Patch application failed: ${error.message}`]
      };
    }
  } catch (error: any) {
    return {
      success: false,
      errors: [`Test execution failed: ${error.message}`]
    };
  }
}

function calculatePatchQuality(patch: string, expectedChange: string): number {
  let score = 100;

  // Check if expected change is in patch
  if (!patch.includes(expectedChange)) {
    score -= 50;
  }

  // Check patch structure
  if (!patch.includes('--- a/') || !patch.includes('+++ b/')) {
    score -= 20;
  }

  if (!patch.includes('@@')) {
    score -= 20;
  }

  // Check for reasonable patch size
  const lines = patch.split('\n').length;
  if (lines > 100) {
    score -= 10;
  }

  return Math.max(0, score);
}
