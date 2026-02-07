#!/usr/bin/env bun
/**
 * Test script to verify patch generation works correctly
 */

import { PatchGenerator } from './scripts/patch-generator';
import { PatchRequest } from './scripts/types';

// Test comment content that simulates a GitHub suggested change
const testCommentContent = `Consider adding error handling here.

\`\`\`suggestion
    const data = await fetch(url);
    if (!data.ok) {
      throw new Error(\`HTTP error! status: \${data.status}\`);
    }
    return data.json();
\`\`\``;

const testRequest: PatchRequest = {
  repo: 'pr-autopilot/test-repo',
  pr: 1,
  commit_sha: 'main',
  file: 'test_file.ts',
  start_line: 3,
  end_line: 4,
  content: testCommentContent,
  diff_hunk: `@@ -2,3 +2,3 @@
 console.log('hello');
-function fetchData(url) {
+// Consider adding error handling here
 function fetchData(url) {
   return fetch(url).then(r => r.json());
 }`,
};

async function main() {
  console.log('========================================');
  console.log('PATCH GENERATION TEST');
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
  console.log('\nComment content:');
  console.log(testRequest.content);
  console.log('\n---\n');

  // Test Level 1 (mechanical extraction)
  console.log('>>> Testing Level 1 (Mechanical extraction) <<<\n');
  const result1 = await generator.generatePatch(testRequest, 1);
  
  console.log('\n--- Level 1 Result ---');
  console.log('Success:', result1.success);
  console.log('Requires approval:', result1.requires_approval);
  if (result1.error) {
    console.log('Error:', result1.error);
  }
  if (result1.patch) {
    console.log('\nGenerated patch:\n');
    console.log(result1.patch);
    console.log('\n--- End Patch ---');
  }

  // Test Level 2 (LLM-assisted)
  console.log('\n\n========================================');
  console.log('>>> Testing Level 2 (LLM-assisted) <<<\n');
  
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
  console.log('TEST COMPLETE');
  console.log('========================================');
}

main().catch(console.error);
