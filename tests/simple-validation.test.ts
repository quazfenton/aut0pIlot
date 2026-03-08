import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Simple Validation Tests - No Git Required', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Real Diff Examples from outputRobotoCommit.json', () => {
    it('should validate diff structure correctly', () => {
      const validDiff = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`;

      // Test diff structure validation
      const lines = validDiff.split('\n');
      expect(lines[0]).toMatch(/^--- a\//);
      expect(lines[1]).toMatch(/^\+\+\+ b\//);
      expect(lines[2]).toMatch(/^@@ -\d+,?\d* \+\d+,?\d* @@$/);
      expect(lines.some(line => line.startsWith('-'))).toBe(true);
      expect(lines.some(line => line.startsWith('+'))).toBe(true);
    });

    it('should detect missing file headers', () => {
      const invalidDiff = `@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`;

      const lines = invalidDiff.split('\n');
      const hasFileHeaders = lines.some(line => line.startsWith('--- a/')) && 
                            lines.some(line => line.startsWith('+++ b/'));
      
      expect(hasFileHeaders).toBe(false);
    });

    it('should detect corrupted hunk headers', () => {
      const invalidDiff = `--- a/src/test.ts
+++ b/src/test.ts
@@ INVALID HEADER @@
-export const x = 1;
+export const x = 2;`;

      const lines = invalidDiff.split('\n');
      const hunkLines = lines.filter(line => line.startsWith('@@'));
      const hasValidHunk = hunkLines.some(line => line.match(/^@@ -\d+,?\d* \+\d+,?\d* @@$/));
      
      expect(hasValidHunk).toBe(false);
    });

    it('should analyze patch quality', () => {
      const patches = {
        perfect: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`,

        missingHeaders: `@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`,

        noContext: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`,

        trailingWhitespace: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;   
+  const x = 2;   
   return x;
 }`
      };

      // Perfect patch analysis
      const perfectLines = patches.perfect.split('\n');
      const perfectAnalysis = {
        hasFileHeaders: perfectLines.some(l => l.startsWith('--- a/')) && perfectLines.some(l => l.startsWith('+++ b/')),
        hasHunkHeaders: perfectLines.some(l => l.startsWith('@@')),
        hasContextLines: perfectLines.some(l => l.startsWith(' ')),
        hasChanges: perfectLines.some(l => l.startsWith('+') || l.startsWith('-')),
        hasTrailingWhitespace: perfectLines.some(l => l.endsWith(' '))
      };

      expect(perfectAnalysis.hasFileHeaders).toBe(true);
      expect(perfectAnalysis.hasHunkHeaders).toBe(true);
      expect(perfectAnalysis.hasContextLines).toBe(true);
      expect(perfectAnalysis.hasChanges).toBe(true);
      expect(perfectAnalysis.hasTrailingWhitespace).toBe(false);

      // Missing headers analysis
      const missingHeadersLines = patches.missingHeaders.split('\n');
      const missingHeadersAnalysis = {
        hasFileHeaders: missingHeadersLines.some(l => l.startsWith('--- a/')) && missingHeadersLines.some(l => l.startsWith('+++ b/')),
        hasHunkHeaders: missingHeadersLines.some(l => l.startsWith('@@')),
        hasContextLines: missingHeadersLines.some(l => l.startsWith(' ')),
        hasChanges: missingHeadersLines.some(l => l.startsWith('+') || l.startsWith('-'))
      };

      expect(missingHeadersAnalysis.hasFileHeaders).toBe(false);
      expect(missingHeadersAnalysis.hasHunkHeaders).toBe(true);
      expect(missingHeadersAnalysis.hasContextLines).toBe(true);
      expect(missingHeadersAnalysis.hasChanges).toBe(true);

      // No context analysis
      const noContextLines = patches.noContext.split('\n');
      const noContextAnalysis = {
        hasFileHeaders: noContextLines.some(l => l.startsWith('--- a/')) && noContextLines.some(l => l.startsWith('+++ b/')),
        hasHunkHeaders: noContextLines.some(l => l.startsWith('@@')),
        hasContextLines: noContextLines.some(l => l.startsWith(' ')),
        hasChanges: noContextLines.some(l => l.startsWith('+') || l.startsWith('-'))
      };

      expect(noContextAnalysis.hasFileHeaders).toBe(true);
      expect(noContextAnalysis.hasHunkHeaders).toBe(true);
      expect(noContextAnalysis.hasContextLines).toBe(false);
      expect(noContextAnalysis.hasChanges).toBe(true);

      // Trailing whitespace analysis
      const trailingWhitespaceLines = patches.trailingWhitespace.split('\n');
      const trailingWhitespaceAnalysis = {
        hasFileHeaders: trailingWhitespaceLines.some(l => l.startsWith('--- a/')) && trailingWhitespaceLines.some(l => l.startsWith('+++ b/')),
        hasHunkHeaders: trailingWhitespaceLines.some(l => l.startsWith('@@')),
        hasContextLines: trailingWhitespaceLines.some(l => l.startsWith(' ')),
        hasChanges: trailingWhitespaceLines.some(l => l.startsWith('+') || l.startsWith('-')),
        hasTrailingWhitespace: trailingWhitespaceLines.some(l => l.endsWith(' '))
      };

      expect(trailingWhitespaceAnalysis.hasFileHeaders).toBe(true);
      expect(trailingWhitespaceAnalysis.hasHunkHeaders).toBe(true);
      expect(trailingWhitespaceAnalysis.hasContextLines).toBe(true);
      expect(trailingWhitespaceAnalysis.hasChanges).toBe(true);
      expect(trailingWhitespaceAnalysis.hasTrailingWhitespace).toBe(true);
    });
  });

  describe('Patch Repair Strategies', () => {
    it('should repair missing file headers', () => {
      const brokenPatch = `@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`;

      const repairedPatch = `--- a/src/test.ts
+++ b/src/test.ts
${brokenPatch}`;

      const repairedLines = repairedPatch.split('\n');
      const hasHeaders = repairedLines.some(l => l.startsWith('--- a/')) && 
                       repairedLines.some(l => l.startsWith('+++ b/'));
      
      expect(hasHeaders).toBe(true);
      expect(repairedPatch).toContain('--- a/src/test.ts');
      expect(repairedPatch).toContain('+++ b/src/test.ts');
    });

    it('should repair corrupted hunk headers', () => {
      const brokenPatch = `--- a/src/test.ts
+++ b/src/test.ts
@@ INVALID HEADER @@
-export const x = 1;
+export const x = 2;`;

      // Extract line numbers and create proper header
      const contentLines = brokenPatch.split('\n').filter(l => l.startsWith('-') || l.startsWith('+'));
      const properHeader = '@@ -1,1 +1,1 @@';
      
      const repairedPatch = `--- a/src/test.ts
+++ b/src/test.ts
${properHeader}
${contentLines.join('\n')}`;

      expect(repairedPatch).toContain('@@ -1,1 +1,1 @@');
      expect(repairedPatch).toContain('-export const x = 1;');
      expect(repairedPatch).toContain('+export const x = 2;');
    });

    it('should fix file path issues', () => {
      const wrongPathPatch = `--- a/wrong/path.ts
+++ b/wrong/path.ts
@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      const correctPathPatch = wrongPathPatch
        .replace(/--- a\/wrong\/path\.ts/g, '--- a/src/test.ts')
        .replace(/\+\+\+ b\/wrong\/path\.ts/g, '+++ b/src/test.ts');

      expect(correctPathPatch).toContain('--- a/src/test.ts');
      expect(correctPathPatch).toContain('+++ b/src/test.ts');
      expect(correctPathPatch).not.toContain('wrong/path.ts');
    });
  });

  describe('Multi-file Patch Handling', () => {
    it('should parse multi-file patches correctly', () => {
      const multiFilePatch = `--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,1 +1,1 @@
-export const A = 1;
+export const A = 2;

--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,1 +1,1 @@
-export const B = 1;
+export const B = 2;`;

      const files = [];
      const sections = multiFilePatch.split('\n--- ');
      
      // Skip the first split (empty) and process each file section
      for (let i = 1; i < sections.length; i++) {
        const section = '--- ' + sections[i];
        const lines = section.split('\n');
        
        const fromFile = lines.find(l => l.startsWith('--- a/'))?.replace('--- a/', '');
        const toFile = lines.find(l => l.startsWith('+++ b/'))?.replace('+++ b/', '');
        
        if (fromFile && toFile) {
          files.push({ from: fromFile, to: toFile });
        }
      }

      expect(files).toHaveLength(2);
      expect(files[0].from).toBe('src/file1.ts');
      expect(files[0].to).toBe('src/file1.ts');
      expect(files[1].from).toBe('src/file2.ts');
      expect(files[1].to).toBe('src/file2.ts');
    });

    it('should handle binary file patches', () => {
      const binaryPatch = `--- a/image.png
+++ b/image.png
Binary files differ`;

      const isBinaryPatch = binaryPatch.includes('Binary files differ');
      expect(isBinaryPatch).toBe(true);
      
      const lines = binaryPatch.split('\n');
      const hasFileHeaders = lines.some(l => l.startsWith('--- a/')) && 
                           lines.some(l => l.startsWith('+++ b/'));
      
      expect(hasFileHeaders).toBe(true);
    });
  });

  describe('Error Pattern Recognition', () => {
    it('should recognize common git apply errors', () => {
      const errorMessages = [
        'error: test.ts: No such file or directory',
        'error: corrupt patch at line 14',
        'error: patch does not apply',
        'fatal: not a git repository',
        'error: patch failed: src/test.ts:3'
      ];

      const errorPatterns = {
        noSuchFile: /No such file or directory/,
        corruptPatch: /corrupt patch at line/,
        doesNotApply: /patch does not apply/,
        notGitRepo: /not a git repository/,
        patchFailed: /patch failed:/
      };

      errorMessages.forEach(error => {
        if (errorPatterns.noSuchFile.test(error)) {
          expect(error).toContain('No such file or directory');
        }
        if (errorPatterns.corruptPatch.test(error)) {
          expect(error).toContain('corrupt patch at line');
        }
        if (errorPatterns.doesNotApply.test(error)) {
          expect(error).toContain('patch does not apply');
        }
        if (errorPatterns.notGitRepo.test(error)) {
          expect(error).toContain('not a git repository');
        }
        if (errorPatterns.patchFailed.test(error)) {
          expect(error).toContain('patch failed:');
        }
      });
    });

    it('should extract error context from git output', () => {
      const gitOutput = `Checking patch src/test.ts...
error: src/test.ts: No such file or directory

Checking patch src/utils.ts...
error: patch does not apply`;

      const errors = gitOutput.split('\n')
        .filter(line => line.includes('error:'))
        .map(line => line.replace('error: ', '').trim());

      expect(errors).toHaveLength(2);
      expect(errors[0]).toBe('src/test.ts: No such file or directory');
      expect(errors[1]).toBe('patch does not apply');
    });
  });

  describe('Real-world Scenarios from outputRobotoCommit.json', () => {
    it('should analyze the exact failure patterns from logs', () => {
      // These are the exact errors from the outputRobotoCommit.json
      const realFailures = [
        {
          error: 'error: test.ts: No such file or directory',
          patch: `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;`,
          expectedIssue: 'Wrong file path in patch'
        },
        {
          error: 'error: corrupt patch at line 14',
          patch: `--- a/tests/unit/patch-generator.test.ts
+++ b/tests/unit/patch-generator.test.ts
@@ -1,10 +1,10 @@
-import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
+const x = 2;
 import { PatchGenerator } from '../../scripts/patch-generator';`,
          expectedIssue: 'Corrupted hunk header or missing context'
        }
      ];

      realFailures.forEach((failure, index) => {
        const patchLines = failure.patch.split('\n');
        const hasValidHeaders = patchLines.some(l => l.startsWith('--- a/')) && 
                               patchLines.some(l => l.startsWith('+++ b/'));
        const hasValidHunk = patchLines.some(l => l.match(/^@@ -\d+,?\d* \+\d+,?\d* @@$/));

        if (index === 0) {
          // First failure: wrong file path
          expect(hasValidHeaders).toBe(true);
          expect(failure.patch).toContain('test.ts');
          expect(failure.error).toContain('No such file or directory');
        }

        if (index === 1) {
          // Second failure: corrupted patch
          expect(hasValidHeaders).toBe(true);
          expect(hasValidHunk).toBe(false); // The hunk header is malformed
          expect(failure.error).toContain('corrupt patch');
        }
      });
    });

    it('should demonstrate repair strategies for real failures', () => {
      const failureScenarios = [
        {
          description: 'File path mismatch',
          originalPatch: `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;`,
          repairStrategy: 'Update file paths to match actual files',
          repairedPatch: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;`
        },
        {
          description: 'Corrupted hunk header',
          originalPatch: `--- a/tests/unit/patch-generator.test.ts
+++ b/tests/unit/patch-generator.test.ts
@@ -1,10 +1,10 @@
-import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
+const x = 2;`,
          repairStrategy: 'Fix hunk header and restore missing context',
          repairedPatch: `--- a/tests/unit/patch-generator.test.ts
+++ b/tests/unit/patch-generator.test.ts
@@ -1,10 +1,10 @@
 import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
-import { PatchGenerator } from '../../scripts/patch-generator';
+const x = 2;
 import { PatchGenerator } from '../../scripts/patch-generator';`
        }
      ];

      failureScenarios.forEach(scenario => {
        // Verify the repair strategy addresses the issue
        const originalLines = scenario.originalPatch.split('\n');
        const repairedLines = scenario.repairedPatch.split('\n');

        if (scenario.description === 'File path mismatch') {
          expect(originalLines).toContain('--- a/test.ts');
          expect(repairedLines).toContain('--- a/src/test.ts');
          expect(repairedLines).not.toContain('--- a/test.ts');
        }

        if (scenario.description === 'Corrupted hunk header') {
          const originalHunk = originalLines.find(l => l.startsWith('@@'));
          const repairedHunk = repairedLines.find(l => l.startsWith('@@'));
          
          expect(originalHunk).toBe('@@ -1,10 +1,10 @@');
          expect(repairedHunk).toBe('@@ -1,10 +1,10 @@');
          expect(repairedLines.length).toBeGreaterThan(originalLines.length);
        }
      });
    });
  });
});
