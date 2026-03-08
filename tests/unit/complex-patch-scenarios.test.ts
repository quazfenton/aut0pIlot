import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PatchErrorAnalyzer } from '../../scripts/patch-error-analyzer';
import { IterativePatchGenerator } from '../../scripts/iterative-patch-generator';
import { GitOps } from '../../scripts/git-ops';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

describe('Complex Patch Scenarios', () => {
  let tempDir: string;
  let testRepoDir: string;
  let gitOps: GitOps;
  let errorAnalyzer: PatchErrorAnalyzer;

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'fake_token';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'complex-patch-test-'));
    testRepoDir = path.join(tempDir, 'test-repo');
    fs.mkdirSync(testRepoDir, { recursive: true });

    gitOps = new GitOps(GITHUB_TOKEN);
    errorAnalyzer = new PatchErrorAnalyzer();

    // Initialize git repo
    execSync('git init', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: testRepoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    gitOps.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Nested Indentation Changes', () => {
    it('should handle deeply nested code changes', () => {
      const fileContent = `class DataProcessor {
  constructor() {
    this.data = [];
  }

  async process(items) {
    for (const item of items) {
      if (item.valid) {
        for (const sub of item.children) {
          if (sub.active) {
            console.log('Processing:', sub.name);
          }
        }
      }
    }
  }
}`;

      const patch = `--- a/src/processor.ts
+++ b/src/processor.ts
@@ -10,7 +10,8 @@ class DataProcessor {
       if (item.valid) {
         for (const sub of item.children) {
           if (sub.active) {
-            console.log('Processing:', sub.name);
+            console.log('Processing:', sub.name, 'at', new Date());
+            this.track(sub);
           }
         }
       }`;

      const analysis = errorAnalyzer.analyzeGitError('', patch, fileContent);
      
      expect(analysis.errorType).toBe('unknown'); // Should be valid
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });

    it('should detect indentation mismatches', () => {
      const fileContent = `function calculate() {
  const x = 1;
  const y = 2;
  return x + y;
}`;

      const wrongIndentPatch = `--- a/src/calc.ts
+++ b/src/calc.ts
@@ -1,5 +1,5 @@
 function calculate() {
-  const x = 1;
-  const y = 2;
+    const x = 1;
+    const y = 2;
   return x + y;
 }`;

      const analysis = errorAnalyzer.analyzeGitError('', wrongIndentPatch, fileContent);
      const highlight = errorAnalyzer.generateDiffHighlight(wrongIndentPatch, fileContent, 'src/calc.ts');

      expect(highlight.mismatches.length).toBeGreaterThan(0);
      expect(highlight.visualDiff).toContain('MISMATCH');
    });
  });

  describe('Multi-Hunk Patches', () => {
    it('should handle patches with multiple hunks', () => {
      const fileContent = `export class Calculator {
  private value: number = 0;

  add(n: number): void {
    this.value += n;
  }

  subtract(n: number): void {
    this.value -= n;
  }

  multiply(n: number): void {
    this.value *= n;
  }

  getValue(): number {
    return this.value;
  }
}`;

      const multiHunkPatch = `--- a/src/calculator.ts
+++ b/src/calculator.ts
@@ -3,6 +3,9 @@ export class Calculator {
 
   add(n: number): void {
     this.value += n;
+    this.log('add', n);
   }
 
   subtract(n: number): void {
@@ -12,6 +15,9 @@ export class Calculator {
 
   multiply(n: number): void {
     this.value *= n;
+    this.log('multiply', n);
   }
 
   getValue(): number {`;

      const analysis = errorAnalyzer.analyzeGitError('', multiHunkPatch, fileContent);
      
      // Should detect this as a valid multi-hunk patch structure
      expect(analysis.hunkHeader).toContain('@@');
    });
  });

  describe('Unicode and Special Characters', () => {
    it('should handle unicode in strings', () => {
      const fileContent = `const messages = {
  greeting: 'Hello',
  farewell: 'Goodbye'
};`;

      const unicodePatch = `--- a/src/messages.ts
+++ b/src/messages.ts
@@ -1,4 +1,4 @@
 const messages = {
-  greeting: 'Hello',
-  farewell: 'Goodbye'
+  greeting: '你好世界',
+  farewell: '再见世界'
 };`;

      const analysis = errorAnalyzer.analyzeGitError('', unicodePatch, fileContent);
      expect(analysis.suggestions).toBeDefined();
    });

    it('should handle emoji in code', () => {
      const fileContent = `const status = {
  SUCCESS: '✅',
  ERROR: '❌',
  WARNING: '⚠️'
};`;

      const emojiPatch = `--- a/src/status.ts
+++ b/src/status.ts
@@ -1,5 +1,6 @@
 const status = {
   SUCCESS: '✅',
   ERROR: '❌',
-  WARNING: '⚠️'
+  WARNING: '⚠️',
+  INFO: 'ℹ️'
 };`;

      const analysis = errorAnalyzer.analyzeGitError('', emojiPatch, fileContent);
      expect(analysis.errorType).toBe('unknown');
    });
  });

  describe('Large File Changes', () => {
    it('should handle patches in large files', () => {
      // Create a file with 500+ lines
      let largeFileContent = '';
      for (let i = 1; i <= 500; i++) {
        largeFileContent += `const line${i} = 'value${i}';\n`;
      }

      const patch = `--- a/src/large.ts
+++ b/src/large.ts
@@ -248,7 +248,7 @@ const line247 = 'value247';
 const line248 = 'value248';
 const line249 = 'value249';
 const line250 = 'value250';
-const line251 = 'value251';
+const line251 = 'UPDATED_value251';
 const line252 = 'value252';
 const line253 = 'value253';
 const line254 = 'value254';`;

      const analysis = errorAnalyzer.analyzeGitError('', patch, largeFileContent);
      const highlight = errorAnalyzer.generateDiffHighlight(patch, largeFileContent, 'src/large.ts');

      expect(highlight.fileStartLine).toBeLessThan(260);
      expect(highlight.mismatches.length).toBeGreaterThan(0);
    });
  });

  describe('Context Mismatch Scenarios', () => {
    it('should detect when context lines have changed', () => {
      const originalContent = `function processData(data) {
  if (!data) {
    return null;
  }
  
  const result = transform(data);
  return result;
}`;

      const modifiedContent = `function processData(data) {
  if (!data || data.isEmpty) {
    return null;
  }
  
  // New comment added
  const result = transform(data);
  return validate(result);
}`;

      const oldPatch = `--- a/src/processor.ts
+++ b/src/processor.ts
@@ -2,7 +2,7 @@ function processData(data) {
   if (!data) {
     return null;
   }
-  
-  const result = transform(data);
+
+  const result = transform(data, { strict: true });
   return result;
 }`;

      // Patch was generated against original, but file has modified content
      const analysis = errorAnalyzer.analyzeGitError(
        'error: patch failed: src/processor.ts:2',
        oldPatch,
        modifiedContent
      );

      expect(analysis.errorType).toBe('context_mismatch');
      expect(analysis.suggestions.length).toBeGreaterThan(0);

      const highlight = errorAnalyzer.generateDiffHighlight(oldPatch, modifiedContent, 'src/processor.ts');
      expect(highlight.visualDiff).toContain('MISMATCH');
    });
  });

  describe('Whitespace-Only Changes', () => {
    it('should handle trailing whitespace removal', () => {
      const fileContent = `function test() {   
  const x = 1;   
  return x;   
}`;

      const whitespacePatch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 function test() {   
-  const x = 1;   
-  return x;   
+  const x = 1;
+  return x;
 }`;

      const analysis = errorAnalyzer.analyzeGitError('', whitespacePatch, fileContent);
      expect(analysis.errorType).toBe('whitespace');
    });

    it('should handle tab vs space changes', () => {
      const fileContent = `function test() {
\tconst x = 1;
\treturn x;
}`;

      const spacePatch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 function test() {
-	const x = 1;
-	return x;
+  const x = 1;
+  return x;
 }`;

      const analysis = errorAnalyzer.analyzeGitError('', spacePatch, fileContent);
      expect(analysis.suggestions).toContainEqual(
        expect.stringContaining('whitespace')
      );
    });
  });

  describe('Empty Line Handling', () => {
    it('should handle patches that add empty lines', () => {
      const fileContent = `class Test {
  method1() {
    return 1;
  }
  method2() {
    return 2;
  }
}`;

      const emptyLinePatch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -3,6 +3,7 @@ class Test {
     return 1;
   }
+
   method2() {
     return 2;
   }`;

      const analysis = errorAnalyzer.analyzeGitError('', emptyLinePatch, fileContent);
      expect(analysis.errorType).toBe('unknown'); // Should be valid
    });

    it('should detect incorrect empty line removal', () => {
      const fileContent = `function test() {
  const a = 1;

  const b = 2;
  return a + b;
}`;

      const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,6 +1,5 @@
 function test() {
   const a = 1;
-
   const b = 2;
   return a + b;
 }`;

      const analysis = errorAnalyzer.analyzeGitError('', patch, fileContent);
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Import/Export Statement Changes', () => {
    it('should handle new import additions', () => {
      const fileContent = `import { foo } from './foo';
import { bar } from './bar';

export function test() {
  return foo(bar());
}`;

      const importPatch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,5 @@
 import { foo } from './foo';
 import { bar } from './bar';
+import { baz } from './baz';
 
 export function test() {`;

      const analysis = errorAnalyzer.analyzeGitError('', importPatch, fileContent);
      expect(analysis.errorType).toBe('unknown');
    });

    it('should handle export statement changes', () => {
      const fileContent = `const helper = () => {};
const main = () => {};

export { helper };`;

      const exportPatch = `--- a/src/module.ts
+++ b/src/module.ts
@@ -2,4 +2,4 @@ const helper = () => {};
 const main = () => {};
 
-export { helper };
+export { helper, main };`;

      const analysis = errorAnalyzer.analyzeGitError('', exportPatch, fileContent);
      expect(analysis.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('Error Visualization Quality', () => {
    it('should generate clear visual diffs for complex errors', () => {
      const fileContent = `async function fetchData(url) {
  try {
    const response = await fetch(url);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Fetch failed:', error);
    throw error;
  }
}`;

      const problematicPatch = `--- a/src/fetch.ts
+++ b/src/fetch.ts
@@ -3,8 +3,9 @@ async function fetchData(url) {
     const response = await fetch(url);
     const data = await response.json();
-    return data;
+    return { success: true, data };
   } catch (error) {
-    console.error('Fetch failed:', error);
+    console.error('Fetch failed:', error.message);
+    logger.log(error);
     throw error;
   }
 }`;

      const highlight = errorAnalyzer.generateDiffHighlight(problematicPatch, fileContent, 'src/fetch.ts');

      // Check visual diff quality
      expect(highlight.visualDiff).toContain('PATCH vs FILE COMPARISON');
      expect(highlight.visualDiff).toContain('FILE CONTENT');
      expect(highlight.visualDiff).toContain('PATCH CONTENT');
      expect(highlight.visualDiff).toContain('SUMMARY');
      expect(highlight.mismatches.length).toBeGreaterThan(0);
    });
  });
});

describe('Iterative Generator Edge Cases', () => {
  let generator: IterativePatchGenerator;
  let gitOps: GitOps;
  let tempDir: string;

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'fake_token';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iterative-edge-'));
    gitOps = new GitOps(GITHUB_TOKEN);
    generator = new IterativePatchGenerator(gitOps);
  });

  afterEach(() => {
    generator.cleanup();
    gitOps.cleanup();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle empty suggestions gracefully', async () => {
    const request = {
      repo: 'test/repo',
      pr: 1,
      commit_sha: 'HEAD',
      file: 'test.ts',
      start_line: 1,
      end_line: 1,
      content: 'Just a comment, no suggestions'
    };

    const result = await generator.generatePatchIterative(request, 1, {
      maxRounds: 1,
      useQwenFullFile: false
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should respect maxRounds limit', async () => {
    const request = {
      repo: 'test/repo',
      pr: 1,
      commit_sha: 'HEAD',
      file: 'test.ts',
      start_line: 1,
      end_line: 1,
      content: 'Fix this'
    };

    const startTime = Date.now();
    const result = await generator.generatePatchIterative(request, 2, {
      maxRounds: 2,
      useQwenFullFile: false
    });
    const duration = Date.now() - startTime;

    // Should not take too long (maxRounds respected)
    expect(duration).toBeLessThan(10000); // Adjust based on actual timing
    expect(result).toBeDefined();
  });

  it('should handle malformed patch requests', async () => {
    const request = {
      repo: 'invalid',
      pr: -1,
      commit_sha: '',
      file: '',
      start_line: -1,
      end_line: -1,
      content: ''
    };

    const result = await generator.generatePatchIterative(request as any, 1, {
      maxRounds: 1
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
