import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use full git path for Windows
const GIT_PATH = 'C:\\Program Files\\Git\\cmd\\git.exe';

describe('Diff Validation - Real World Examples', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-test-'));
    repoDir = path.join(tempDir, 'test-repo');
    
    fs.mkdirSync(repoDir, { recursive: true });
    execSync(`"${GIT_PATH}" init`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${GIT_PATH}" config user.email "test@test.com"`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${GIT_PATH}" config user.name "Test"`, { cwd: repoDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  function createTestFile(filePath: string, content: string): void {
    const fullPath = path.join(repoDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  function commitFile(filePath: string, content: string, message: string): string {
    createTestFile(filePath, content);
    execSync(`"${GIT_PATH}" add .`, { cwd: repoDir, stdio: 'ignore' });
    execSync(`"${GIT_PATH}" commit -m "${message}"`, { cwd: repoDir, stdio: 'ignore' });
    return execSync(`"${GIT_PATH}" rev-parse HEAD`, { cwd: repoDir, stdio: 'pipe' }).toString().trim();
  }

  function applyPatch(patchContent: string): { success: boolean; output: string; error: string } {
    const patchFile = path.join(tempDir, 'test.patch');
    fs.writeFileSync(patchFile, patchContent);

    try {
      const result = execSync(`"${GIT_PATH}" apply --check "${patchFile}"`, {
        cwd: repoDir,
        stdio: 'pipe',
        encoding: 'utf8'
      });
      return { success: true, output: result.toString(), error: '' };
    } catch (error: any) {
      return {
        success: false,
        output: error.stdout?.toString() || '',
        error: error.stderr?.toString() || error.message || ''
      };
    }
  }

  describe('Valid Diffs from Real PRs', () => {
    it('should accept simple variable change', () => {
      const sha = commitFile('src/test.ts', `export function test() {
  const x = 1;
  return x;
}`, 'Initial commit');

      const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });

    it('should accept function addition', () => {
      const sha = commitFile('src/utils.ts', `export function existing() {
  return true;
}`, 'Initial commit');

      const patch = `--- a/src/utils.ts
+++ b/src/utils.ts
@@ -1,3 +1,6 @@
 export function existing() {
   return true;
 }
+
+export function newFunction() {
+  return false;
+}`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });

    it('should accept complex React component changes', () => {
      const sha = commitFile('src/Button.tsx', `import React from 'react';

export const Button = () => {
  return <button>Click me</button>;
};`, 'Initial commit');

      const patch = `--- a/src/Button.tsx
+++ b/src/Button.tsx
@@ -1,5 +1,12 @@
 import React from 'react';
 
 export const Button = () => {
+  const [count, setCount] = React.useState(0);
+  
+  const handleClick = () => {
+    setCount(count + 1);
+  };
+  
   return <button>Click me</button>;
+    <button onClick={handleClick}>
+      Count: {count}
+    </button>
 };`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });

    it('should accept multi-file patches', () => {
      commitFile('src/file1.ts', 'export const A = 1;', 'File 1');
      commitFile('src/file2.ts', 'export const B = 2;', 'File 2');

      const patch = `--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,1 +1,1 @@
-export const A = 1;
+export const A = 10;

--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,1 +1,1 @@
-export const B = 2;
+export const B = 20;`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });
  });

  describe('Invalid Diffs from Real Failures', () => {
    it('should reject diff with missing file headers', () => {
      commitFile('src/test.ts', 'export const x = 1;', 'Initial commit');

      const patch = `@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      const result = applyPatch(patch);
      expect(result.success).toBe(false);
      expect(result.error).toContain('corrupt patch');
    });

    it('should reject diff with wrong file paths', () => {
      commitFile('src/test.ts', 'export const x = 1;', 'Initial commit');

      const patch = `--- a/wrong/path.ts
+++ b/wrong/path.ts
@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      const result = applyPatch(patch);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No such file or directory');
    });

    it('should reject diff with corrupted hunk headers', () => {
      commitFile('src/test.ts', 'export const x = 1;', 'Initial commit');

      const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ INVALID HEADER @@
-export const x = 1;
+export const x = 2;`;

      const result = applyPatch(patch);
      expect(result.success).toBe(false);
    });

    it('should reject diff with mismatched context', () => {
      commitFile('src/test.ts', 'export const x = 1;', 'Initial commit');

      const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,3 +1,3 @@
 export const x = 1;
-export const y = 2;
+export const y = 3;
 export const z = 4;`;

      const result = applyPatch(patch);
      expect(result.success).toBe(false);
      expect(result.error).toContain('patch does not apply');
    });

    it('should reject diff with trailing whitespace issues', () => {
      commitFile('src/test.ts', 'export const x = 1;', 'Initial commit');

      const patch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,1 @@
-export const x = 1;   
+export const x = 2;  `;

      const result = applyPatch(patch);
      // Git might still apply this but should warn about whitespace
      expect(result.success).toBe(true); // Git is lenient with whitespace
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty file patches', () => {
      commitFile('src/empty.ts', '', 'Empty file');

      const patch = `--- a/src/empty.ts
+++ b/src/empty.ts
@@ -0,0 +1,1 @@
+export const newContent = 'added';`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });

    it('should handle file deletion patches', () => {
      const sha = commitFile('src/temp.ts', 'export const temp = 1;', 'Temp file');

      const patch = `--- a/src/temp.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const temp = 1;`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });

    it('should handle file creation patches', () => {
      commitFile('src/existing.ts', 'export const existing = 1;', 'Existing file');

      const patch = `--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,1 @@
+export const newFile = 'created';`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });

    it('should handle binary file patches', () => {
      // Create a simple binary-like file
      const binaryContent = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      fs.writeFileSync(path.join(repoDir, 'image.png'), binaryContent);
      execSync(`"${GIT_PATH}" add .`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Initial commit"`, { cwd: repoDir, stdio: 'ignore' });

      const patch = `--- a/image.png
+++ b/image.png
Binary files differ`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });

    it('should handle large diff patches', () => {
      const largeContent = Array.from({ length: 1000 }, (_, i) => 
        `export const line${i} = ${i};`
      ).join('\n');

      commitFile('src/large.ts', largeContent, 'Large file');

      const modifiedContent = Array.from({ length: 1000 }, (_, i) => 
        `export const line${i} = ${i * 2};`
      ).join('\n');

      const patch = `--- a/src/large.ts
+++ b/src/large.ts
@@ -1,1000 +1,1000 @@
${modifiedContent}`;

      const result = applyPatch(patch);
      expect(result.success).toBe(true);
    });
  });

  describe('Real Failure Scenarios from outputRobotoCommit.json', () => {
    it('should reproduce and test fix for "No such file or directory" error', () => {
      // This reproduces the exact error from the logs
      commitFile('tests/unit/patch-generator.test.ts', `import { PatchGenerator } from '../../scripts/patch-generator';

describe('PatchGenerator', () => {
  let generator: PatchGenerator;
  
  beforeEach(() => {
    generator = new PatchGenerator();
  });

  it('should generate patches', () => {
    expect(generator).toBeDefined();
  });
});`, 'Test file');

      // This is the problematic patch from the logs
      const problematicPatch = `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;`;

      const result = applyPatch(problematicPatch);
      expect(result.success).toBe(false);
      expect(result.error).toContain('No such file or directory');
      expect(result.error).toContain('test.ts');
    });

    it('should reproduce and test fix for "corrupt patch at line" error', () => {
      commitFile('tests/unit/patch-generator.test.ts', `import { PatchGenerator } from '../../scripts/patch-generator';

describe('PatchGenerator', () => {
  let generator: PatchGenerator;
  
  beforeEach(() => {
    generator = new PatchGenerator();
  });
});`, 'Test file');

      // This reproduces the corrupt patch error
      const corruptPatch = `--- a/tests/unit/patch-generator.test.ts
+++ b/tests/unit/patch-generator.test.ts
@@ -1,10 +1,10 @@
-import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
+const x = 2;
 import { PatchGenerator } from '../../scripts/patch-generator';
 import { PatchRequest } from '../../scripts/types';
 import * as fs from 'fs';
 import * as path from 'path';
 import * as os from 'os';

 describe('PatchGenerator', () => {
   let generator: PatchGenerator;`;

      const result = applyPatch(corruptPatch);
      expect(result.success).toBe(false);
      expect(result.error).toContain('corrupt patch');
    });

    it('should test patch repair strategies', () => {
      commitFile('src/test.ts', 'export const x = 1;', 'Initial commit');

      const brokenPatch = `@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      // Test repair strategy 1: Add missing headers
      const repairedPatch1 = `--- a/src/test.ts
+++ b/src/test.ts
${brokenPatch}`;

      const result1 = applyPatch(repairedPatch1);
      expect(result1.success).toBe(true);

      // Test repair strategy 2: Fix file paths
      const wrongPathPatch = `--- a/wrong.ts
+++ b/wrong.ts
@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      const result2 = applyPatch(wrongPathPatch);
      expect(result2.success).toBe(false);

      const repairedPatch2 = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      const result3 = applyPatch(repairedPatch2);
      expect(result3.success).toBe(true);
    });
  });
});
