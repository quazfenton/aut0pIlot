import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RobustPatchGenerator } from '../scripts/robust-patch-generator';
import { EnhancedQwenSession, EnhancedQwenOptions } from '../scripts/enhanced-qwen-session';
import { EnhancedLogger } from '../scripts/enhanced-logging';
import { PersistentPatchStateManager } from '../scripts/persistent-patch-state';
import { GitOps } from '../scripts/git-ops';
import { PatchRequest, ParsedReviewComment } from '../scripts/types';

describe('Enhanced PR Autopilot - Comprehensive Tests', () => {
  let tempDir: string;
  let repoDir: string;
  let gitOps: GitOps;
  let robustGenerator: RobustPatchGenerator;
  let stateManager: PersistentPatchStateManager;
  let logger: EnhancedLogger;

  // Real diff examples from actual PR failures
  const realDiffExamples = {
    validSimpleDiff: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`,

    validComplexDiff: `--- a/src/components/Button.tsx
+++ b/src/components/Button.tsx
@@ -10,7 +10,9 @@ export const Button: React.FC<ButtonProps> = ({
   const [isLoading, setIsLoading] = useState(false);
 
   const handleClick = async () => {
+    setIsLoading(true);
     try {
       await onClick();
+    } finally {
+      setIsLoading(false);
     }
   };
 
@@ -25,6 +27,7 @@ export const Button: React.FC<ButtonProps> = ({
     <button
       className={cn(
         'px-4 py-2 rounded',
+        isLoading && 'opacity-50',
         className
       )}
       disabled={disabled || isLoading}`,

    malformedDiffMissingHeaders: `@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`,

    malformedDiffCorruptHunk: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
 corrupt patch at line 4`,

    malformedDiffWrongPaths: `--- a/test.ts
+++ b/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;
+  const x = 2;
   return x;
 }`,

    diffWithContextIssues: `--- a/src/utils.ts
+++ b/src/utils.ts
@@ -50,3 +50,4 @@
 export function helper() {
   return true;
 }
+export function newHelper() {
+  return false;
+}`,

    multiFileDiff: `--- a/src/file1.ts
+++ b/src/file1.ts
@@ -1,2 +1,2 @@
-export const A = 1;
+export const A = 2;

--- a/src/file2.ts
+++ b/src/file2.ts
@@ -1,2 +1,2 @@
-export const B = 1;
+export const B = 2;`,

    diffWithTrailingWhitespace: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 export function test() {
-  const x = 1;   
+  const x = 2;   
   return x;
 }`
  };

  const realPatchRequests: PatchRequest[] = [
    {
      repo: 'test/repo',
      pr: 123,
      commit_sha: 'abc123',
      file: 'src/test.ts',
      start_line: 1,
      end_line: 4,
      content: 'Fix the variable assignment',
      context: 'export function test() {\n  const x = 1;\n  return x;\n}',
      suggestions: [
        { code: 'const x = 2;', source: 'github' }
      ],
      proposed_fixes: ['Change x from 1 to 2']
    },
    {
      repo: 'test/repo',
      pr: 124,
      commit_sha: 'def456',
      file: 'src/components/Button.tsx',
      start_line: 10,
      end_line: 30,
      content: 'Add loading state handling',
      context: 'const handleClick = async () => {\n  try {\n    await onClick();\n  } catch (error) {\n    console.error(error);\n  }\n};',
      suggestions: [
        { code: 'setIsLoading(true);\ntry {\n  await onClick();\n} finally {\n  setIsLoading(false);\n}', source: 'coderabbit' }
      ]
    },
    {
      repo: 'test/repo',
      pr: 125,
      commit_sha: 'ghi789',
      file: 'src/utils.ts',
      start_line: 50,
      end_line: 52,
      content: 'Add new helper function',
      agent_prompt: 'Add a new helper function that returns false'
    }
  ];

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-autopilot-test-'));
    repoDir = path.join(tempDir, 'test-repo');
    
    // Initialize git repository
    fs.mkdirSync(repoDir, { recursive: true });
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: repoDir, stdio: 'ignore' });

    // Create test files
    createTestFiles();

    // Initial commit
    execSync('git add .', { cwd: repoDir, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: repoDir, stdio: 'ignore' });

    // Initialize components
    gitOps = new GitOps('fake-token');
    robustGenerator = new RobustPatchGenerator(gitOps);
    stateManager = new PersistentPatchStateManager();
    logger = new EnhancedLogger('test-session');

    // Mock GitOps methods
    vi.spyOn(gitOps, 'clone').mockResolvedValue();
    vi.spyOn(gitOps, 'checkout').mockResolvedValue();
    vi.spyOn(gitOps, 'getRepoDir').mockReturnValue(repoDir);
  });

  afterEach(() => {
    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    vi.clearAllMocks();
  });

  function createTestFiles() {
    // Create test files that match our patch requests
    const files = {
      'src/test.ts': `export function test() {
  const x = 1;
  return x;
}`,
      'src/components/Button.tsx': `import React, { useState } from 'react';
import { cn } from '../utils/cn';

interface ButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export const Button: React.FC<ButtonProps> = ({
  onClick,
  disabled = false,
  className
}) => {
  const [isLoading, setIsLoading] = useState(false);

  const handleClick = async () => {
    try {
      await onClick();
    } catch (error) {
      console.error(error);
    }
  };

  return (
    <button
      className={cn(
        'px-4 py-2 rounded',
        className
      )}
      disabled={disabled || isLoading}
      onClick={handleClick}
    >
      {isLoading ? 'Loading...' : 'Click'}
    </button>
  );
};`,
      'src/utils.ts': `export function helper() {
  return true;
}

export function otherHelper() {
  return 'hello';
}`,
      'package.json': JSON.stringify({
        name: 'test-repo',
        version: '1.0.0',
        dependencies: {
          react: '^18.0.0'
        }
      }, null, 2),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          target: 'ES2020',
          module: 'commonjs',
          strict: true
        }
      }, null, 2)
    };

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(repoDir, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }

  describe('RobustPatchGenerator', () => {
    it('should handle valid simple diffs correctly', async () => {
      const request = realPatchRequests[0];
      
      // Mock the mechanical extraction to return our valid diff
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue(['const x = 2;']);
      vi.spyOn(robustGenerator as any, 'createMechanicalPatch').mockReturnValue(realDiffExamples.validSimpleDiff);
      vi.spyOn(robustGenerator as any, 'validatePatch').mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        appliedFiles: ['src/test.ts'],
        failedFiles: []
      });

      const result = await robustGenerator.generateRobustPatch(request, 2, false);

      expect(result.success).toBe(true);
      expect(result.patch).toContain('const x = 2;');
      expect(result.requires_approval).toBe(false);
    });

    it('should attempt repair for malformed diffs', async () => {
      const request = realPatchRequests[0];
      
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue(['const x = 2;']);
      vi.spyOn(robustGenerator as any, 'createMechanicalPatch').mockReturnValue(realDiffExamples.malformedDiffMissingHeaders);
      
      // First validation fails, second succeeds after repair
      vi.spyOn(robustGenerator as any, 'validatePatch')
        .mockResolvedValueOnce({
          isValid: false,
          errors: ['Missing file headers'],
          warnings: [],
          appliedFiles: [],
          failedFiles: [{ file: 'src/test.ts', error: 'Missing file headers' }]
        })
        .mockResolvedValueOnce({
          isValid: true,
          errors: [],
          warnings: [],
          appliedFiles: ['src/test.ts'],
          failedFiles: []
        });

      vi.spyOn(robustGenerator as any, 'repairPatch').mockResolvedValue(realDiffExamples.validSimpleDiff);

      const result = await robustGenerator.generateRobustPatch(request, 2, false);

      expect(result.success).toBe(true);
      expect(robustGenerator.repairPatch).toHaveBeenCalled();
    });

    it('should handle multiple repair attempts', async () => {
      const request = realPatchRequests[1];
      
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue([]);
      
      // Mock traditional LLM to fail
      const mockPatchGenerator = {
        generatePatch: vi.fn().mockResolvedValue({
          success: false,
          error: 'LLM generation failed'
        })
      };
      
      vi.spyOn(robustGenerator as any, 'tryTraditionalLLM').mockResolvedValue({
        success: false,
        error: 'Traditional LLM failed'
      });

      // Mock enhanced Qwen to fail initially, then succeed
      vi.spyOn(robustGenerator as any, 'tryEnhancedQwen')
        .mockResolvedValueOnce({
          success: false,
          error: 'Qwen CLI failed'
        })
        .mockResolvedValueOnce({
          success: true,
          patch: realDiffExamples.validComplexDiff,
          editedFiles: [{ file: 'src/components/Button.tsx', content: 'updated content' }]
        });

      vi.spyOn(robustGenerator as any, 'tryFinalRepair').mockResolvedValue({
        success: false,
        error: 'Final repair failed'
      });

      const result = await robustGenerator.generateRobustPatch(request, 2, true);

      expect(result.success).toBe(true);
      expect(robustGenerator.tryEnhancedQwen).toHaveBeenCalledTimes(2);
    });

    it('should fail gracefully when all methods fail', async () => {
      const request = realPatchRequests[0];
      
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue([]);
      vi.spyOn(robustGenerator as any, 'tryTraditionalLLM').mockResolvedValue({
        success: false,
        error: 'Traditional LLM failed'
      });
      vi.spyOn(robustGenerator as any, 'tryEnhancedQwen').mockResolvedValue({
        success: false,
        error: 'Enhanced Qwen failed'
      });
      vi.spyOn(robustGenerator as any, 'tryFinalRepair').mockResolvedValue({
        success: false,
        error: 'Final repair failed'
      });

      const result = await robustGenerator.generateRobustPatch(request, 2, true);

      expect(result.success).toBe(false);
      expect(result.error).toContain('All patch generation methods failed');
    });
  });

  describe('EnhancedLogger', () => {
    it('should create structured logs correctly', () => {
      logger.info('TEST_CATEGORY', 'Test message', { key: 'value' });
      
      const summary = logger.getSummary();
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.byLevel.INFO).toBeGreaterThan(0);
      expect(summary.byCategory.TEST_CATEGORY).toBeGreaterThan(0);
    });

    it('should analyze diff quality correctly', () => {
      const diffAnalysis = logger.generateDiffReport(
        realDiffExamples.validSimpleDiff,
        [],
        ['src/test.ts']
      );

      expect(diffAnalysis.finalResult).toBe('SUCCESS');
      expect(diffAnalysis.validationErrors).toHaveLength(0);
      expect(diffAnalysis.appliedChanges).toHaveLength(1);
    });

    it('should detect diff quality issues', () => {
      const diffAnalysis = logger.generateDiffReport(
        realDiffExamples.malformedDiffMissingHeaders,
        ['Missing file headers'],
        []
      );

      expect(diffAnalysis.finalResult).toBe('FAILED');
      expect(diffAnalysis.validationErrors).toContain('Missing file headers');
      expect(diffAnalysis.warnings.length).toBeGreaterThan(0);
    });

    it('should export logs successfully', () => {
      logger.info('EXPORT_TEST', 'Testing export functionality');
      
      const exportPath = logger.exportLogs();
      expect(fs.existsSync(exportPath)).toBe(true);
      
      const exportedData = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
      expect(exportedData.entries).toBeDefined();
      expect(exportedData.summary).toBeDefined();
    });
  });

  describe('PersistentPatchStateManager', () => {
    it('should create and retrieve patch states correctly', () => {
      const patchState = stateManager.createPatchState(
        'test/repo',
        123,
        'src/test.ts',
        1,
        4,
        'comment-123'
      );

      expect(patchState.id).toBeDefined();
      expect(patchState.status).toBe('PENDING');
      expect(patchState.attempts).toHaveLength(0);

      const retrieved = stateManager.getPatchState(patchState.id);
      expect(retrieved).toEqual(patchState);
    });

    it('should update patch status correctly', () => {
      const patchState = stateManager.createPatchState(
        'test/repo',
        123,
        'src/test.ts',
        1,
        4,
        'comment-123'
      );

      stateManager.updatePatchStatus(patchState.id, 'APPLIED', 'test patch');
      
      const updated = stateManager.getPatchState(patchState.id);
      expect(updated?.status).toBe('APPLIED');
      expect(updated?.currentPatch).toBe('test patch');
    });

    it('should add patch attempts correctly', () => {
      const patchState = stateManager.createPatchState(
        'test/repo',
        123,
        'src/test.ts',
        1,
        4,
        'comment-123'
      );

      stateManager.addPatchAttempt(
        patchState.id,
        'mechanical',
        'test patch',
        undefined,
        [],
        0,
        1000
      );

      const updated = stateManager.getPatchState(patchState.id);
      expect(updated?.attempts).toHaveLength(1);
      expect(updated?.attempts[0].method).toBe('mechanical');
      expect(updated?.attempts[0].duration).toBe(1000);
    });

    it('should create and manage batch commits correctly', () => {
      const patch1 = stateManager.createPatchState('test/repo', 123, 'src/file1.ts', 1, 2, 'c1');
      const patch2 = stateManager.createPatchState('test/repo', 123, 'src/file2.ts', 1, 2, 'c2');

      const batch = stateManager.createBatchCommit('test/repo', 123, [patch1.id, patch2.id]);
      
      expect(batch.status).toBe('PENDING');
      expect(batch.patches).toHaveLength(2);

      stateManager.updateBatchStatus(batch.id, 'COMMITTED', 'sha123');
      
      const updated = stateManager.getBatchCommit(batch.id);
      expect(updated?.status).toBe('COMMITTED');
      expect(updated?.commitSha).toBe('sha123');
    });

    it('should recover pending work correctly', () => {
      // Create some patches
      const patch1 = stateManager.createPatchState('test/repo', 123, 'src/file1.ts', 1, 2, 'c1');
      const patch2 = stateManager.createPatchState('test/repo', 123, 'src/file2.ts', 1, 2, 'c2');
      
      // Mark one as failed
      stateManager.updatePatchStatus(patch2.id, 'FAILED', undefined, 'Test failure');

      const recovered = stateManager.recoverPendingWork();
      
      expect(recovered.failedPatches).toHaveLength(1);
      expect(recovered.failedPatches[0].id).toBe(patch2.id);
    });

    it('should generate comprehensive reports', () => {
      // Create test data
      const patch1 = stateManager.createPatchState('test/repo', 123, 'src/file1.ts', 1, 2, 'c1');
      const patch2 = stateManager.createPatchState('test/repo', 124, 'src/file2.ts', 1, 2, 'c2');
      
      stateManager.updatePatchStatus(patch1.id, 'APPLIED');
      stateManager.updatePatchStatus(patch2.id, 'FAILED');

      const report = stateManager.generateReport();
      
      expect(report.summary.totalPatches).toBe(2);
      expect(report.summary.appliedPatches).toBe(1);
      expect(report.summary.failedPatches).toBe(1);
      expect(report.patches).toHaveLength(2);
    });
  });

  describe('Real-world Scenario Tests', () => {
    it('should handle complex multi-file edits', async () => {
      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 126,
        commit_sha: 'jkl012',
        file: 'src/utils.ts',
        start_line: 45,
        end_line: 55,
        content: 'Refactor utility functions and add new helpers',
        suggestions: [
          { code: 'export function newUtil() { return true; }', source: 'github' },
          { code: 'export function anotherUtil() { return false; }', source: 'coderabbit' }
        ]
      };

      // Mock successful generation
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue([
        'export function newUtil() { return true; }',
        'export function anotherUtil() { return false; }'
      ]);
      vi.spyOn(robustGenerator as any, 'createMechanicalPatch').mockReturnValue(realDiffExamples.multiFileDiff);
      vi.spyOn(robustGenerator as any, 'validatePatch').mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: ['Multiple files modified'],
        appliedFiles: ['src/file1.ts', 'src/file2.ts'],
        failedFiles: []
      });

      const result = await robustGenerator.generateRobustPatch(request, 2, false);

      expect(result.success).toBe(true);
      expect(result.patch).toContain('file1.ts');
      expect(result.patch).toContain('file2.ts');
    });

    it('should handle edge case: empty patches', async () => {
      const request = realPatchRequests[0];
      
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue([]);
      vi.spyOn(robustGenerator as any, 'tryTraditionalLLM').mockResolvedValue({
        success: false,
        error: 'No content to patch'
      });
      vi.spyOn(robustGenerator as any, 'tryEnhancedQwen').mockResolvedValue({
        success: false,
        error: 'Qwen could not generate content'
      });

      const result = await robustGenerator.generateRobustPatch(request, 2, true);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should handle concurrent patch requests', async () => {
      const requests = realPatchRequests.slice(0, 3);
      
      // Mock all to succeed
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue(['test change']);
      vi.spyOn(robustGenerator as any, 'createMechanicalPatch').mockReturnValue(realDiffExamples.validSimpleDiff);
      vi.spyOn(robustGenerator as any, 'validatePatch').mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        appliedFiles: ['test.ts'],
        failedFiles: []
      });

      const promises = requests.map(req => robustGenerator.generateRobustPatch(req, 2, false));
      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });

    it('should handle large file patches', async () => {
      const largeContent = 'export function largeFunction() {\n' + 
        '  // Many lines of code\n' + 
        Array.from({ length: 100 }, (_, i) => `  const line${i} = ${i};`).join('\n') +
        '\n  return true;\n' +
        '}';

      const request: PatchRequest = {
        repo: 'test/repo',
        pr: 127,
        commit_sha: 'mno345',
        file: 'src/large.ts',
        start_line: 1,
        end_line: 103,
        content: 'Add large function with many lines',
        context: largeContent
      };

      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue([largeContent]);
      vi.spyOn(robustGenerator as any, 'createMechanicalPatch').mockReturnValue(
        `--- a/src/large.ts
+++ b/src/large.ts
@@ -1,103 +1,103 @@
${largeContent}`
      );
      vi.spyOn(robustGenerator as any, 'validatePatch').mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: ['Large patch detected'],
        appliedFiles: ['src/large.ts'],
        failedFiles: []
      });

      const result = await robustGenerator.generateRobustPatch(request, 2, false);

      expect(result.success).toBe(true);
      expect(result.patch?.length).toBeGreaterThan(1000); // Should be substantial
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle git operation failures gracefully', async () => {
      const request = realPatchRequests[0];
      
      // Mock git operations to fail
      vi.spyOn(gitOps, 'clone').mockRejectedValue(new Error('Git clone failed'));
      
      const result = await robustGenerator.generateRobustPatch(request, 2, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Git clone failed');
    });

    it('should handle timeout scenarios', async () => {
      const request = realPatchRequests[0];
      
      // Mock slow operation
      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockImplementation(() => {
        return new Promise(resolve => setTimeout(() => resolve(['test']), 15000));
      });

      const startTime = Date.now();
      const result = await robustGenerator.generateRobustPatch(request, 2, false);
      const duration = Date.now() - startTime;

      expect(result.success).toBe(false);
      expect(duration).toBeLessThan(15000); // Should timeout before 15 seconds
    });

    it('should handle corrupted state files', () => {
      // Create corrupted state file
      const corruptedStateDir = path.join(os.tmpdir(), 'pr-autopilot-state-corrupted');
      fs.mkdirSync(corruptedStateDir, { recursive: true });
      fs.writeFileSync(path.join(corruptedStateDir, 'patch-states.json'), '{ invalid json }');

      const corruptedManager = new PersistentPatchStateManager();
      
      // Should not crash, should handle gracefully
      expect(() => {
        corruptedManager.createPatchState('test/repo', 123, 'test.ts', 1, 2, 'c1');
      }).not.toThrow();
    });

    it('should handle memory pressure scenarios', async () => {
      const requests = Array.from({ length: 50 }, (_, i) => ({
        ...realPatchRequests[0],
        pr: 1000 + i,
        file: `src/file${i}.ts`
      }));

      vi.spyOn(robustGenerator as any, 'extractSuggestions').mockReturnValue(['test']);
      vi.spyOn(robustGenerator as any, 'createMechanicalPatch').mockReturnValue(realDiffExamples.validSimpleDiff);
      vi.spyOn(robustGenerator as any, 'validatePatch').mockResolvedValue({
        isValid: true,
        errors: [],
        warnings: [],
        appliedFiles: [`src/file${requests.length - 1}.ts`],
        failedFiles: []
      });

      const results = await Promise.all(
        requests.map(req => robustGenerator.generateRobustPatch(req, 2, false))
      );

      expect(results).toHaveLength(50);
      expect(results.every(r => r.success)).toBe(true);
    });
  });
});
