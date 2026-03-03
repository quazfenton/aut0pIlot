#!/usr/bin/env bun
/**
 * Test to verify unified diff format is correct
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

// Create test directory
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-test-'));
console.log(`Test directory: ${testDir}`);

// Create a test file
const testFile = path.join(testDir, 'test.ts');
const originalContent = `// Line 1
// Line 2
function fetchData(url: string) {
  const data = await fetch(url);
  return data.json();
}
// Line 7
// Line 8
// Line 9
`;

fs.writeFileSync(testFile, originalContent);
console.log('Created test file with content:');
console.log(originalContent);
console.log('---');

// Create a git repo
execSync('git init', { cwd: testDir, stdio: 'ignore' });
execSync('git config user.email "test@test.com"', { cwd: testDir, stdio: 'ignore' });
execSync('git config user.name "Test"', { cwd: testDir, stdio: 'ignore' });
execSync('git add .', { cwd: testDir, stdio: 'ignore' });
execSync('git commit -m "initial"', { cwd: testDir, stdio: 'ignore' });

// Define new code (lines 4-5 will be replaced)
const newCode = `function fetchData(url: string) {
  const data = await fetch(url);
  if (!data.ok) {
    throw new Error(\`HTTP error! status: \${data.status}\`);
  }
  return data.json();
}`;

// Simulate createUnifiedDiffFromCode logic
function createUnifiedDiff(
  filePath: string,
  startLine: number,
  endLine: number,
  lines: string[],
  newCode: string
): string {
  const newLines = newCode.split('\n');
  
  // Context lines (standard unified diff uses 3 lines of context)
  const contextLines = 3;
  
  // Calculate the actual start of the hunk (including context before)
  const hunkStartLine = Math.max(1, startLine - contextLines);
  
  // Calculate how many context lines we actually have before
  const contextBeforeCount = startLine - hunkStartLine;
  
  // Calculate context after
  const contextAfterStart = endLine;
  const contextAfterCount = Math.min(contextLines, lines.length - contextAfterStart);
  
  // Old file: context before + removed lines + context after
  const oldCount = contextBeforeCount + (endLine - startLine + 1) + contextAfterCount;
  
  // New file: context before + added lines + context after
  const newCount = contextBeforeCount + newLines.length + contextAfterCount;

  let patch = `--- a/${filePath}\n`;
  patch += `+++ b/${filePath}\n`;
  patch += `@@ -${hunkStartLine},${oldCount} +${hunkStartLine},${newCount} @@\n`;

  // Context before
  for (let i = hunkStartLine - 1; i < startLine - 1 && i < lines.length; i++) {
    patch += ' ' + lines[i] + '\n';
  }

  // Removed lines
  for (let i = startLine - 1; i <= endLine - 1 && i < lines.length; i++) {
    patch += '-' + lines[i] + '\n';
  }

  // Added lines
  for (const line of newLines) {
    patch += '+' + line + '\n';
  }

  // Context after
  for (let i = contextAfterStart; i < contextAfterStart + contextAfterCount && i < lines.length; i++) {
    patch += ' ' + lines[i] + '\n';
  }

  return patch;
}

const lines = originalContent.split('\n');
const patch = createUnifiedDiff('test.ts', 4, 5, lines, newCode);

console.log('\n=== GENERATED PATCH ===');
console.log(patch);
console.log('=== END PATCH ===\n');

// Write patch to file and test it
const patchFile = path.join(testDir, 'test.patch');
fs.writeFileSync(patchFile, patch);

console.log('Testing patch with git apply --check...');
try {
  execSync(`git apply --check "${patchFile}"`, { cwd: testDir, stdio: 'pipe' });
  console.log('✅ Patch validation PASSED!');
  
  // Actually apply it
  console.log('\nApplying patch...');
  execSync(`git apply "${patchFile}"`, { cwd: testDir, stdio: 'pipe' });
  
  const result = fs.readFileSync(testFile, 'utf-8');
  console.log('\n=== FILE AFTER PATCH ===');
  console.log(result);
  console.log('=== END FILE ===');
  
  console.log('\n✅ Patch applied successfully!');
} catch (e: any) {
  console.log('❌ Patch validation FAILED:', e.stderr?.toString() || e.message);
}

// Cleanup
fs.rmSync(testDir, { recursive: true, force: true });
console.log(`\nCleaned up ${testDir}`);
