#!/usr/bin/env bun
/**
 * Test script to verify LLM patch generation improvements
 */

import { PatchGenerator } from './scripts/patch-generator';
import { PatchRequest } from './scripts/types';

// Test the specific scenario that was failing
const complexDiffHunk = `@@ -10,15 +10,18 @@
 function calculateTotal(items) {
-  let total = 0;
-  for (let i = 0; i < items.length; i++) {
-    total += items[i].price;
-  }
-  return total;
+  return items.reduce((total, item) => {
+    if (item.price && item.quantity) {
+      return total + (item.price * item.quantity);
+    }
+    return total;
+  }, 0);
 }

-// Old implementation
-function getTotalPrice(cart) {
-  return calculateTotal(cart.items);
+// Updated implementation with validation
+function getTotalPrice(cart, options = {}) {
+  const { includeTax = false, taxRate = 0.1 } = options;
+  let subtotal = calculateTotal(cart.items);
+  return includeTax ? subtotal * (1 + taxRate) : subtotal;
 }`;

const testRequest: PatchRequest = {
  repo: 'pr-autopilot/test-repo',
  pr: 4,
  commit_sha: 'main',
  file: 'complex.ts',
  start_line: 10,
  end_line: 25,
  content: 'Update the calculation logic',
  diff_hunk: complexDiffHunk,
} as PatchRequest;

async function testLLMGeneration() {
  console.log('========================================');
  console.log('LLM PATCH GENERATION IMPROVEMENT TEST');
  console.log('========================================\n');

  const generator = new PatchGenerator();

  console.log('Test Request:');
  console.log(JSON.stringify({
    repo: testRequest.repo,
    pr: testRequest.pr,
    file: testRequest.file,
    start_line: testRequest.start_line,
    end_line: testRequest.end_line,
    has_diff_hunk: !!testRequest.diff_hunk,
  }, null, 2));
  console.log('\nDiff hunk:');
  console.log(testRequest.diff_hunk);
  console.log('\n---\n');

  // Test Level 2 (LLM-assisted) which was failing
  console.log('>>> Testing Level 2 (LLM-assisted) - Complex Diff <<<\n');

  const result2 = await generator.generatePatch(testRequest, 2);

  console.log('\n--- Level 2 Result ---');
  console.log('Success:', result2.success);
  console.log('Requires approval:', result2.requires_approval);
  if (result2.error) {
    console.log('Error:', result2.error);
  }
  if (result2.patch) {
    console.log('\nGenerated patch:\n');
    console.log(result2.patch);
    console.log('\n--- End Patch ---');
  }

  generator.cleanup();

  console.log('\n========================================');
  console.log('LLM IMPROVEMENT TEST COMPLETE');
  console.log('========================================');
}

testLLMGeneration().catch(console.error);