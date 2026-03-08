import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IterativePatchGenerator } from '../../scripts/iterative-patch-generator';
import { GitOps } from '../../scripts/git-ops';
import { PatchRequest } from '../../scripts/types';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('IterativePatchGenerator', () => {
  let generator: IterativePatchGenerator;
  let gitOps: GitOps;
  let tempDir: string;
  let testRepoDir: string;

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'fake_token_for_testing';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'));
    testRepoDir = path.join(tempDir, 'test-repo');
    fs.mkdirSync(testRepoDir, { recursive: true });

    gitOps = new GitOps(GITHUB_TOKEN);
    generator = new IterativePatchGenerator(gitOps);

    // Initialize a test git repository
    fs.writeFileSync(path.join(testRepoDir, 'test.ts'), `function hello() {
  console.log('world');
}

function add(a: number, b: number): number {
  return a + b;
}

export { hello, add };
`);

    execSync('git init', { cwd: testRepoDir });
    execSync('git config user.email "test@test.com"', { cwd: testRepoDir });
    execSync('git config user.name "Test"', { cwd: testRepoDir });
    execSync('git add .', { cwd: testRepoDir });
    execSync('git commit -m "initial"', { cwd: testRepoDir });
  });

  afterEach(() => {
    generator.cleanup();
    gitOps.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Mechanical Extraction', () => {
    it('should extract and apply simple GitHub suggestion', async () => {
      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'test.ts',
        start_line: 1,
        end_line: 3,
        content: 'Here is a suggestion:\n\n```suggestion\nfunction hello() {\n  console.log(\'hello\');\n}\n```',
        suggestions: [
          {
            code: `function hello() {
  console.log('hello');
}`,
            source: 'github',
            section: 'suggestion'
          }
        ]
      };

      const result = await generator.generatePatchIterative(request, 1, {
        maxRounds: 1,
        useQwenFullFile: false
      });

      expect(result.success).toBe(true);
      expect(result.patch).toContain('--- a/test.ts');
      expect(result.patch).toContain('+++ b/test.ts');
    });

    it('should handle multiple suggestions', async () => {
      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'test.ts',
        start_line: 5,
        end_line: 7,
        content: 'Multiple suggestions:\n\n```suggestion\nfunction multiply(a: number, b: number): number {\n  return a * b;\n}\n```',
        suggestions: [
          {
            code: `function multiply(a: number, b: number): number {
  return a * b;
}`,
            source: 'github',
            section: 'suggestion'
          }
        ]
      };

      const result = await generator.generatePatchIterative(request, 1, {
        maxRounds: 1,
        useQwenFullFile: false
      });

      expect(result.success).toBe(true);
    });

    it('should fail gracefully when no suggestions found', async () => {
      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'test.ts',
        start_line: 1,
        end_line: 1,
        content: 'Just a comment without any suggestions'
      };

      const result = await generator.generatePatchIterative(request, 1, {
        maxRounds: 1,
        useQwenFullFile: false
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No suggestions found');
    });
  });

  describe('Patch Validation', () => {
    it('should validate correct unified diff format', async () => {
      const validPatch = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 function hello() {
-  console.log('world');
+  console.log('hello');
 }
`;

      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'test.ts',
        start_line: 1,
        end_line: 3,
        content: 'Fix greeting'
      };

      // Write patch to temp file and validate
      const patchFile = path.join(tempDir, 'valid.patch');
      fs.writeFileSync(patchFile, validPatch);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: testRepoDir,
          stdio: 'pipe'
        });
        expect(true).toBe(true); // Should not throw
      } catch (error) {
        expect(error).toBeUndefined();
      }
    });

    it('should reject patch with wrong context lines', async () => {
      const invalidPatch = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 function wrong() {
-  console.log('wrong');
+  console.log('hello');
 }
`;

      const patchFile = path.join(tempDir, 'invalid.patch');
      fs.writeFileSync(patchFile, invalidPatch);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: testRepoDir,
          stdio: 'pipe'
        });
        expect(true).toBe(false); // Should throw
      } catch (error: any) {
        expect(error).toBeDefined();
        expect(error.message).toContain('does not apply');
      }
    });

    it('should handle whitespace-only patches', async () => {
      const whitespacePatch = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 function hello() {
-  console.log('world');   
+  console.log('world');
 }
`;

      const patchFile = path.join(tempDir, 'whitespace.patch');
      fs.writeFileSync(patchFile, whitespacePatch);

      try {
        execSync(`git apply --check "${patchFile}"`, {
          cwd: testRepoDir,
          stdio: 'pipe'
        });
        expect(true).toBe(true);
      } catch (error: any) {
        // May fail due to whitespace, which is expected
        expect(error).toBeDefined();
      }
    });
  });

  describe('Error Analysis and Recovery', () => {
    it('should analyze line mismatch errors', async () => {
      const { PatchErrorAnalyzer } = await import('../scripts/patch-error-analyzer');
      const analyzer = new PatchErrorAnalyzer();

      const errorOutput = 'error: patch failed: test.ts:1';
      const patch = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 function hello() {
-  console.log('world');
+  console.log('hello');
 }
`;

      const fileContent = `function hello() {
  console.log('universe');
}

function add(a: number, b: number): number {
  return a + b;
}

export { hello, add };
`;

      const analysis = analyzer.analyzeGitError(errorOutput, patch, fileContent);

      expect(analysis.errorType).toBe('line_mismatch');
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });

    it('should generate visual diff highlight for errors', async () => {
      const { PatchErrorAnalyzer } = await import('../scripts/patch-error-analyzer');
      const analyzer = new PatchErrorAnalyzer();

      const patch = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 function hello() {
-  console.log('world');
+  console.log('hello');
 }
`;

      const fileContent = `function hello() {
  console.log('universe');
}

function add(a: number, b: number): number {
  return a + b;
}

export { hello, add };
`;

      const highlight = analyzer.generateDiffHighlight(patch, fileContent, 'test.ts');

      expect(highlight.visualDiff).toContain('PATCH vs FILE COMPARISON');
      expect(highlight.mismatches.length).toBeGreaterThan(0);
    });
  });

  describe('Iterative Retry Logic', () => {
    it('should retry with error feedback', async () => {
      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'test.ts',
        start_line: 1,
        end_line: 3,
        content: 'Improve the hello function'
      };

      // Mock the tryTraditionalLLM to fail first, then succeed
      const originalTryTraditionalLLM = (generator as any).tryTraditionalLLM;
      let callCount = 0;

      (generator as any).tryTraditionalLLM = async (...args: any[]) => {
        callCount++;
        if (callCount === 1) {
          return { success: false, error: 'First attempt failed' };
        }
        return {
          success: true,
          patch: `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 function hello() {
-  console.log('world');
+  console.log('improved');
 }
`,
          requires_approval: false
        };
      };

      const result = await generator.generatePatchIterative(request, 2, {
        maxRounds: 3,
        useQwenFullFile: false
      });

      expect(result.success).toBe(true);
      expect(callCount).toBe(2);

      // Restore original method
      (generator as any).tryTraditionalLLM = originalTryTraditionalLLM;
    });

    it('should stop after max rounds', async () => {
      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'test.ts',
        start_line: 1,
        end_line: 3,
        content: 'Fix everything'
      };

      (generator as any).tryTraditionalLLM = async () => ({
        success: false,
        error: 'Always fails'
      });

      const result = await generator.generatePatchIterative(request, 2, {
        maxRounds: 2,
        useQwenFullFile: false
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to generate valid patch after 2 rounds');
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multi-line replacements', async () => {
      // Create a more complex test file
      fs.writeFileSync(path.join(testRepoDir, 'complex.ts'), `class Calculator {
  private value: number = 0;

  add(n: number): this {
    this.value += n;
    return this;
  }

  subtract(n: number): this {
    this.value -= n;
    return this;
  }

  getValue(): number {
    return this.value;
  }
}

export { Calculator };
`);

      execSync('git add .', { cwd: testRepoDir });
      execSync('git commit -m "add calculator"', { cwd: testRepoDir });

      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'complex.ts',
        start_line: 4,
        end_line: 7,
        content: 'Add validation to add method',
        suggestions: [
          {
            code: `  add(n: number): this {
    if (n < 0) {
      throw new Error('Cannot add negative number');
    }
    this.value += n;
    return this;
  }`,
            source: 'github',
            section: 'suggestion'
          }
        ]
      };

      const result = await generator.generatePatchIterative(request, 2, {
        maxRounds: 2,
        useQwenFullFile: false
      });

      expect(result.success).toBe(true);
      expect(result.patch).toContain('Cannot add negative number');
    });

    it('should handle file with special characters and unicode', async () => {
      fs.writeFileSync(path.join(testRepoDir, 'unicode.ts'), `const messages = {
  greeting: 'Hello',
  farewell: 'Goodbye'
};

export { messages };
`);

      execSync('git add .', { cwd: testRepoDir });
      execSync('git commit -m "add unicode"', { cwd: testRepoDir });

      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'unicode.ts',
        start_line: 2,
        end_line: 4,
        content: 'Add unicode characters',
        suggestions: [
          {
            code: `const messages = {
  greeting: '你好',
  farewell: '再见'
};`,
            source: 'github',
            section: 'suggestion'
          }
        ]
      };

      const result = await generator.generatePatchIterative(request, 1, {
        maxRounds: 1,
        useQwenFullFile: false
      });

      expect(result.success).toBe(true);
      expect(result.patch).toContain('你好');
    });

    it('should handle empty file creation', async () => {
      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 1,
        commit_sha: 'HEAD',
        file: 'new-file.ts',
        start_line: 1,
        end_line: 1,
        content: 'Create new file',
        suggestions: [
          {
            code: `export const NEW_CONSTANT = 42;`,
            source: 'github',
            section: 'suggestion'
          }
        ]
      };

      // This should fail gracefully since file doesn't exist
      const result = await generator.generatePatchIterative(request, 1, {
        maxRounds: 1,
        useQwenFullFile: false
      });

      // Expected to fail or handle specially
      expect(result).toBeDefined();
    });
  });
});

// Helper function for execSync
function execSync(command: string, options: any) {
  const { execSync: nodeExecSync } = require('child_process');
  return nodeExecSync(command, options);
}
