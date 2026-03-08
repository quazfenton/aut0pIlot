#!/usr/bin/env node

/**
 * Advanced Diff Examples Test Runner
 * 
 * This script demonstrates and tests the enhanced patch generation
 * with full Qwen mode enabled, including visual diff highlighting.
 */

import { PatchErrorAnalyzer } from './scripts/patch-error-analyzer.js';
import { IterativePatchGenerator } from './scripts/iterative-patch-generator.js';
import { GitOps } from './scripts/git-ops.js';
import { createSessionLogger } from './scripts/enhanced-logging.js';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Enable full Qwen mode
const FULL_QWEN_MODE = true;
const DEBUG_MODE = true;

const log = {
  header: (msg) => console.log(`\n\x1b[1;38;5;208m╔══════════════════════════════════════════════════════════════╗\x1b[0m`),
  title: (msg) => console.log(`\x1b[1;38;5;208m║  ${msg.padEnd(60)} ║\x1b[0m`),
  footer: () => console.log(`\x1b[1;38;5;208m╚══════════════════════════════════════════════════════════════╝\x1b[0m\n`),
  step: (msg) => console.log(`\x1b[32m[STEP]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  diff: (msg) => console.log(`\x1b[38;5;245m[DIFF]\x1b[0m ${msg}`),
  qwen: (msg) => console.log(`\x1b[38;5;213m[QWEN-FULL-MODE]\x1b[0m ${msg}`),
};

// Test cases with advanced diff scenarios
const testScenarios = [
  {
    name: 'Nested Indentation Change',
    description: 'Testing deeply nested code with indentation preservation',
    fileContent: `class DataProcessor {
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
}`,
    patch: `--- a/src/processor.ts
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
       }`,
    expectedMismatches: 0,  // Should be valid
  },
  {
    name: 'Context Mismatch Detection',
    description: 'Testing detection when file has changed since patch generation',
    fileContent: `function processData(data) {
  if (!data || data.isEmpty) {
    return null;
  }
  
  // New comment added
  const result = transform(data);
  return validate(result);
}`,
    oldPatch: `--- a/src/processor.ts
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
 }`,
    expectedMismatches: 2,  // Should detect context changes
  },
  {
    name: 'Unicode and Emoji Support',
    description: 'Testing proper handling of unicode characters and emoji',
    fileContent: `const status = {
  SUCCESS: '✅',
  ERROR: '❌',
  WARNING: '⚠️',
  INFO: 'ℹ️'
};

export function getStatusIcon(type) {
  return status[type] || '❓';
}`,
    patch: `--- a/src/status.ts
+++ b/src/status.ts
@@ -3,7 +3,8 @@ const status = {
   ERROR: '❌',
   WARNING: '⚠️',
   INFO: 'ℹ️'
-};
+};
+
 
 export function getStatusIcon(type) {
   return status[type] || '❓';`,
    expectedMismatches: 0,
  },
  {
    name: 'Multi-Hunk Patch',
    description: 'Testing patches with multiple separate changes',
    fileContent: `export class Calculator {
  private value = 0;

  add(n) {
    this.value += n;
  }

  subtract(n) {
    this.value -= n;
  }

  multiply(n) {
    this.value *= n;
  }

  getValue() {
    return this.value;
  }
}`,
    patch: `--- a/src/calculator.ts
+++ b/src/calculator.ts
@@ -3,6 +3,7 @@ export class Calculator {
 
   add(n) {
     this.value += n;
+    this.log('add', n);
   }
 
   subtract(n) {
@@ -12,6 +13,7 @@ export class Calculator {
 
   multiply(n) {
     this.value *= n;
+    this.log('multiply', n);
   }
 
   getValue() {`,
    expectedMismatches: 0,
  },
  {
    name: 'Whitespace-Only Changes',
    description: 'Testing detection of whitespace differences',
    fileContent: `function test() {   
  const x = 1;   
  return x;   
}`,
    patch: `--- a/src/test.ts
+++ b/src/test.ts
@@ -1,4 +1,4 @@
 function test() {   
-  const x = 1;   
-  return x;   
+  const x = 1;
+  return x;
 }`,
    expectedMismatches: 0,  // Whitespace issue
  },
  {
    name: 'Large File Context',
    description: 'Testing patch application in large files',
    fileContent: Array.from({ length: 500 }, (_, i) => `const line${i + 1} = 'value${i + 1}';`).join('\n'),
    patch: `--- a/src/large.ts
+++ b/src/large.ts
@@ -248,7 +248,7 @@ const line248 = 'value248';
 const line249 = 'value249';
 const line250 = 'value250';
-const line251 = 'value251';
+const line251 = 'UPDATED_value251';
 const line252 = 'value252';
 const line253 = 'value253';
 const line254 = 'value254';`,
    expectedMismatches: 0,
  },
];

/**
 * Run visual diff analysis test
 */
function runVisualDiffTest(scenario) {
  log.step(`Running: ${scenario.name}`);
  log.info(scenario.description);

  const analyzer = new PatchErrorAnalyzer();
  
  // Analyze the patch
  const analysis = analyzer.analyzeGitError('', scenario.patch, scenario.fileContent);
  
  // Generate visual diff highlight
  const highlight = analyzer.generateDiffHighlight(scenario.patch, scenario.fileContent, 'src/test-file.ts');
  
  // Display results
  console.log('\n' + '='.repeat(70));
  console.log(`Test: ${scenario.name}`);
  console.log('='.repeat(70));
  
  // Show visual diff
  console.log(highlight.visualDiff);
  
  // Show analysis
  console.log('\n\x1b[1;36mAnalysis Results:\x1b[0m');
  console.log(`  Error Type: ${analysis.errorType}`);
  console.log(`  Mismatches Found: ${highlight.mismatches.length}`);
  console.log(`  Expected Mismatches: ${scenario.expectedMismatches}`);
  console.log(`  Suggestions: ${analysis.suggestions.length}`);
  
  // Validate
  // FIX: Require both conditions when expecting 0 mismatches to avoid false positives
  const passed = scenario.expectedMismatches === 0
    ? (highlight.mismatches.length === 0 && analysis.errorType === 'unknown')
    : (highlight.mismatches.length === scenario.expectedMismatches);

  if (passed) {
    log.success(`✓ Test PASSED: ${scenario.name}`);
  } else {
    log.warn(`⚠ Test MAY NEED REVIEW: ${scenario.name}`);
    log.info(`  Mismatches: ${highlight.mismatches.length}, Expected: ${scenario.expectedMismatches}, ErrorType: ${analysis.errorType}`);
  }
  
  console.log('='.repeat(70) + '\n');
  
  return passed;
}

/**
 * Run iterative patch generation test with Qwen full-file mode
 */
async function runIterativeTest() {
  log.header();
  log.title('QWEN FULL-MODE ITERATIVE TEST');
  log.footer();

  if (!FULL_QWEN_MODE) {
    log.warn('Full Qwen mode is disabled, skipping iterative test');
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-test-'));
  const testRepoDir = path.join(tempDir, 'test-repo');
  fs.mkdirSync(testRepoDir, { recursive: true });

  try {
    // Initialize test git repo
    log.step('Setting up test repository...');
    execSync('git init', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: testRepoDir, stdio: 'ignore' });

    // Create test file
    const testFile = path.join(testRepoDir, 'example.ts');
    fs.writeFileSync(testFile, `function hello() {
  console.log('world');
}

export { hello };
`);

    execSync('git add .', { cwd: testRepoDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: testRepoDir, stdio: 'ignore' });

    log.success('Test repository created');

    // Initialize components
    const gitOps = new GitOps(process.env.GITHUB_TOKEN || 'fake_token');
    const logger = createSessionLogger({
      sessionId: `qwen-test-${Date.now()}`,
      logDir: './logs',
      captureThinking: true,
      saveToFile: true
    });

    const generator = new IterativePatchGenerator(gitOps);

    // Test request
    const request = {
      repo: 'test/repo',
      pr: 1,
      commit_sha: 'HEAD',
      file: 'example.ts',
      start_line: 1,
      end_line: 3,
      content: 'Change the greeting from "world" to "hello universe"',
      suggestions: [
        {
          code: `function hello() {
  console.log('hello universe');
}`,
          source: 'github',
          section: 'suggestion'
        }
      ]
    };

    log.step('Starting iterative patch generation with Full Qwen Mode...');
    log.qwen(`Max rounds: 5, Timeout: 120000ms per round`);

    const result = await generator.generatePatchIterative(request, 2, {
      maxRounds: 3,
      maxLlmRetries: 2,
      useQwenFullFile: FULL_QWEN_MODE,
      timeoutPerRound: 60000
    });

    // Display results
    console.log('\n' + '='.repeat(70));
    console.log('Iterative Generation Results');
    console.log('='.repeat(70));

    if (result.success) {
      log.success('Patch generation SUCCEEDED!');
      console.log('\n\x1b[1;32mGenerated Patch:\x1b[0m');
      console.log(result.patch);
    } else {
      log.error('Patch generation FAILED');
      console.log('\n\x1b[1;31mError:\x1b[0m');
      console.log(result.error);
    }

    console.log('\n\x1b[1;36mSession Info:\x1b[0m');
    console.log(`  Rounds: ${result.rounds}`);
    console.log(`  Thinking available: ${!!result.thinking}`);

    // Save session report
    const reportPath = logger.saveSessionReport();
    log.info(`Session report saved to: ${reportPath}`);

    gitOps.cleanup();
    generator.cleanup();

    console.log('='.repeat(70) + '\n');

    return result.success;

  } catch (error) {
    log.error(`Iterative test failed: ${error.message}`);
    console.error(error.stack);
    return false;
  } finally {
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Main test runner
 */
async function main() {
  log.header();
  log.title('ADVANCED DIFF EXAMPLES TEST SUITE');
  log.title(`Full Qwen Mode: ${FULL_QWEN_MODE ? 'ENABLED' : 'DISABLED'}`);
  log.title(`Debug Mode: ${DEBUG_MODE ? 'ENABLED' : 'DISABLED'}`);
  log.footer();

  const results = {
    visualDiffTests: { passed: 0, failed: 0 },
    iterativeTest: { passed: 0, failed: 0 }
  };

  // Run visual diff tests
  log.step('Running Visual Diff Analysis Tests...\n');
  
  for (const scenario of testScenarios) {
    try {
      const passed = runVisualDiffTest(scenario);
      if (passed) {
        results.visualDiffTests.passed++;
      } else {
        results.visualDiffTests.failed++;
      }
    } catch (error) {
      log.error(`Test "${scenario.name}" threw error: ${error.message}`);
      results.visualDiffTests.failed++;
    }

    // Add delay between tests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Run iterative generation test
  if (FULL_QWEN_MODE) {
    log.step('Running Iterative Patch Generation Test...\n');
    
    try {
      const passed = await runIterativeTest();
      if (passed) {
        results.iterativeTest.passed++;
      } else {
        results.iterativeTest.failed++;
      }
    } catch (error) {
      log.error(`Iterative test threw error: ${error.message}`);
      results.iterativeTest.failed++;
    }
  }

  // Summary
  log.header();
  log.title('TEST SUMMARY');
  log.footer();

  console.log('\x1b[1;36mVisual Diff Tests:\x1b[0m');
  console.log(`  ✓ Passed: ${results.visualDiffTests.passed}`);
  console.log(`  ✗ Failed: ${results.visualDiffTests.failed}`);

  if (FULL_QWEN_MODE) {
    console.log('\n\x1b[1;36mIterative Test (Qwen Full-Mode):\x1b[0m');
    console.log(`  ✓ Passed: ${results.iterativeTest.passed}`);
    console.log(`  ✗ Failed: ${results.iterativeTest.failed}`);
  }

  const totalPassed = results.visualDiffTests.passed + results.iterativeTest.passed;
  const totalFailed = results.visualDiffTests.failed + results.iterativeTest.failed;
  const total = totalPassed + totalFailed;

  console.log(`\n\x1b[1;37mOverall: ${totalPassed}/${total} tests passed\x1b[0m`);

  if (totalFailed === 0) {
    log.success('\n🎉 All tests passed!\n');
    process.exit(0);
  } else {
    log.warn(`\n⚠️  ${totalFailed} test(s) need review\n`);
    process.exit(1);
  }
}

// Run the tests
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
