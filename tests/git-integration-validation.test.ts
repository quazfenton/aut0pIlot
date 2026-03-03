import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use full git path for Windows
const GIT_PATH = 'C:\\Program Files\\Git\\cmd\\git.exe';

describe('Git Integration Validation - Fixed Path Tests', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-test-'));
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

  describe('Git Operations with Full Path', () => {
    it('should initialize git repository successfully', () => {
      // This should work now with full path
      expect(fs.existsSync(path.join(repoDir, '.git'))).toBe(true);
    });

    it('should create commits successfully', () => {
      const testFile = path.join(repoDir, 'test.txt');
      fs.writeFileSync(testFile, 'Hello World');
      
      execSync(`"${GIT_PATH}" add test.txt`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Test commit"`, { cwd: repoDir, stdio: 'ignore' });
      
      const result = execSync(`"${GIT_PATH}" log --oneline`, { 
        cwd: repoDir, 
        stdio: 'pipe',
        encoding: 'utf8'
      });
      
      expect(result.toString()).toContain('Test commit');
    });

    it('should apply patches successfully', () => {
      // Create initial file
      const testFile = path.join(repoDir, 'patch-test.txt');
      fs.writeFileSync(testFile, 'Original content');
      
      execSync(`"${GIT_PATH}" add patch-test.txt`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Initial file"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Create patch
      const patch = `--- a/patch-test.txt
+++ b/patch-test.txt
@@ -1,1 +1,1 @@
-Original content
+Modified content`;

      const patchFile = path.join(tempDir, 'test.patch');
      fs.writeFileSync(patchFile, patch);
      
      // Apply patch
      execSync(`"${GIT_PATH}" apply "${patchFile}"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Verify patch was applied
      const modifiedContent = fs.readFileSync(testFile, 'utf8');
      expect(modifiedContent).toBe('Modified content');
    });

    it('should handle patch validation with check', () => {
      // Create initial file
      const testFile = path.join(repoDir, 'validation-test.txt');
      fs.writeFileSync(testFile, 'Line 1\nLine 2\nLine 3');
      
      execSync(`"${GIT_PATH}" add validation-test.txt`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Initial file for validation"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Create valid patch
      const validPatch = `--- a/validation-test.txt
+++ b/validation-test.txt
@@ -1,3 +1,3 @@
 Line 1
-Line 2
+Modified Line 2
 Line 3`;

      const patchFile = path.join(tempDir, 'valid.patch');
      fs.writeFileSync(patchFile, validPatch);
      
      // Check patch (should succeed)
      const result = execSync(`"${GIT_PATH}" apply --check "${patchFile}"`, { 
        cwd: repoDir, 
        stdio: 'pipe',
        encoding: 'utf8'
      });
      
      // Should not output any errors
      expect(result.toString()).toBe('');
    });

    it('should detect invalid patches', () => {
      // Create initial file
      const testFile = path.join(repoDir, 'invalid-test.txt');
      fs.writeFileSync(testFile, 'Original content');
      
      execSync(`"${GIT_PATH}" add invalid-test.txt`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Initial file for invalid test"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Create invalid patch (wrong file path)
      const invalidPatch = `--- a/wrong-file.txt
+++ b/wrong-file.txt
@@ -1,1 +1,1 @@
-Original content
+Modified content`;

      const patchFile = path.join(tempDir, 'invalid.patch');
      fs.writeFileSync(patchFile, invalidPatch);
      
      // Check patch (should fail)
      try {
        execSync(`"${GIT_PATH}" apply --check "${patchFile}"`, { 
          cwd: repoDir, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        expect.fail('Should have thrown an error for invalid patch');
      } catch (error: any) {
        expect(error.stderr?.toString()).toContain('No such file or directory');
        expect(error.stderr?.toString()).toContain('wrong-file.txt');
      }
    });

    it('should handle multi-file patches', () => {
      // Create multiple files
      const file1 = path.join(repoDir, 'file1.txt');
      const file2 = path.join(repoDir, 'file2.txt');
      
      fs.writeFileSync(file1, 'Content 1');
      fs.writeFileSync(file2, 'Content 2');
      
      execSync(`"${GIT_PATH}" add .`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Multiple files"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Create multi-file patch
      const multiFilePatch = `--- a/file1.txt
+++ b/file1.txt
@@ -1,1 +1,1 @@
-Content 1
+Modified Content 1

--- a/file2.txt
+++ b/file2.txt
@@ -1,1 +1,1 @@
-Content 2
+Modified Content 2`;

      const patchFile = path.join(tempDir, 'multi.patch');
      fs.writeFileSync(patchFile, multiFilePatch);
      
      // Apply patch
      execSync(`"${GIT_PATH}" apply "${patchFile}"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Verify both files were modified
      expect(fs.readFileSync(file1, 'utf8')).toBe('Modified Content 1');
      expect(fs.readFileSync(file2, 'utf8')).toBe('Modified Content 2');
    });
  });

  describe('Real-World Scenarios from outputRobotoCommit.json', () => {
    it('should reproduce "No such file or directory" error and fix it', () => {
      // Create a file with different name than in patch
      const actualFile = path.join(repoDir, 'src', 'test.ts');
      fs.mkdirSync(path.dirname(actualFile), { recursive: true });
      fs.writeFileSync(actualFile, 'export const x = 1;');
      
      execSync(`"${GIT_PATH}" add .`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Initial file"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Create patch with wrong file path (reproducing the error)
      const wrongPathPatch = `--- a/test.ts
+++ b/test.ts
@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      const patchFile = path.join(tempDir, 'wrong-path.patch');
      fs.writeFileSync(patchFile, wrongPathPatch);
      
      // This should fail with "No such file or directory"
      try {
        execSync(`"${GIT_PATH}" apply --check "${patchFile}"`, { 
          cwd: repoDir, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        expect.fail('Should have failed with wrong path');
      } catch (error: any) {
        expect(error.stderr?.toString()).toContain('No such file or directory');
        expect(error.stderr?.toString()).toContain('test.ts');
      }
      
      // Now fix the patch by correcting the path
      const fixedPatch = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,1 +1,1 @@
-export const x = 1;
+export const x = 2;`;

      const fixedPatchFile = path.join(tempDir, 'fixed.patch');
      fs.writeFileSync(fixedPatchFile, fixedPatch);
      
      // This should succeed
      const result = execSync(`"${GIT_PATH}" apply --check "${fixedPatchFile}"`, { 
        cwd: repoDir, 
        stdio: 'pipe',
        encoding: 'utf8'
      });
      
      expect(result.toString()).toBe('');
    });

    it('should reproduce "corrupt patch at line" error and fix it', () => {
      // Create a proper file
      const testFile = path.join(repoDir, 'test.ts');
      fs.writeFileSync(testFile, `export function test() {\n  return true;\n}`);
      
      execSync(`"${GIT_PATH}" add test.ts`, { cwd: repoDir, stdio: 'ignore' });
      execSync(`"${GIT_PATH}" commit -m "Initial file"`, { cwd: repoDir, stdio: 'ignore' });
      
      // Create corrupted patch (reproducing the error)
      const corruptedPatch = `--- a/test.ts
+++ b/test.ts
@@ INVALID HEADER @@
-export function test() {
+const x = 2;
  return true;
}`;

      const patchFile = path.join(tempDir, 'corrupted.patch');
      fs.writeFileSync(patchFile, corruptedPatch);
      
      // This should fail with "corrupt patch"
      try {
        execSync(`"${GIT_PATH}" apply --check "${patchFile}"`, { 
          cwd: repoDir, 
          stdio: 'pipe',
          encoding: 'utf8'
        });
        expect.fail('Should have failed with corrupt patch');
      } catch (error: any) {
        expect(error.stderr?.toString()).toContain('corrupt patch');
      }
      
      // Fix the patch by correcting the hunk header
      const fixedPatch = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 export function test() {
+const x = 2;
   return true;
 }`;

      const fixedPatchFile = path.join(tempDir, 'fixed-corrupted.patch');
      fs.writeFileSync(fixedPatchFile, fixedPatch);
      
      // This should succeed
      const result = execSync(`"${GIT_PATH}" apply --check "${fixedPatchFile}"`, { 
        cwd: repoDir, 
        stdio: 'pipe',
        encoding: 'utf8'
      });
      
      expect(result.toString()).toBe('');
    });
  });
});
