#!/usr/bin/env bun
/**
 * Test script to verify patch generation works correctly with advanced variations
 */

import { PatchGenerator } from './scripts/patch-generator';
import { PatchRequest } from './scripts/types';

// Test different scenarios for patch generation

// Scenario 1: Basic error handling suggestion
const basicSuggestionContent = `Consider adding error handling here.

\`\`\`suggestion
    const data = await fetch(url);
    if (!data.ok) {
      throw new Error(\`HTTP error! status: \${data.status}\`);
    }
    return data.json();
\`\`\``;

// Scenario 2: Indentation-sensitive code (inside a loop/function)
const indentationSensitiveContent = `Fix the indentation issue in the loop.

\`\`\`suggestion
        for (const item of items) {
          console.log(item);
          if (item.needsProcessing) {
            await processItem(item);
          }
        }
\`\`\``;

// Scenario 3: Multi-line context change
const multiLineChangeContent = `Update the function signature and implementation.

\`\`\`suggestion
async function processUserData(userData, options = {}) {
  const { timeout = 5000, retries = 3 } = options;
  
  for (let i = 0; i < retries; i++) {
    try {
      const result = await fetchUserData(userData, { timeout });
      return result;
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(timeout * (i + 1)); // exponential backoff
    }
  }
}
\`\`\``;

// Scenario 4: Complex diff hunk with multiple changes
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

// Scenario 5: Nested structure changes
const nestedStructureContent = `Fix the nested conditional logic.

\`\`\`suggestion
if (user && user.profile) {
  if (user.profile.settings) {
    if (user.profile.settings.notifications) {
      // Process notifications
      handleNotifications(user.profile.settings.notifications);
    } else {
      // Default notification settings
      handleNotifications(DEFAULT_NOTIFICATIONS);
    }
  } else {
    // Default settings
    handleNotifications(DEFAULT_SETTINGS);
  }
} else {
  // Anonymous user
  handleNotifications(ANONYMOUS_SETTINGS);
}
\`\`\``;

// Scenario 6: Import statement addition
const importAdditionContent = `Add the missing import for the utility function.

\`\`\`suggestion
import { validateInput, sanitizeData } from './utils/validation';
import { processData } from './utils/processing';
import { DEFAULT_CONFIG } from './config';

export async function handleRequest(req, res) {
  try {
    const validatedInput = validateInput(req.body);
    const sanitizedData = sanitizeData(validatedInput);
    const processedData = await processData(sanitizedData);
    res.json(processedData);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}
\`\`\``;

// Define test scenarios
const testScenarios = [
  {
    name: 'Basic Error Handling',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 1,
      commit_sha: 'main',
      file: 'test_file.ts',
      start_line: 3,
      end_line: 4,
      content: basicSuggestionContent,
      diff_hunk: `@@ -2,3 +2,3 @@
 console.log('hello');
-function fetchData(url) {
+// Consider adding error handling here
 function fetchData(url) {
   return fetch(url).then(r => r.json());
 }`,
    } as PatchRequest
  },
  {
    name: 'Indentation-Sensitive Code',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 2,
      commit_sha: 'main',
      file: 'indented_code.ts',
      start_line: 5,
      end_line: 8,
      content: indentationSensitiveContent,
      diff_hunk: `@@ -4,7 +4,7 @@
   console.log('processing');
-  oldLoopImplementation();
+  // Fix the indentation issue in the loop
   oldLoopImplementation();
   console.log('done');
 }`,
    } as PatchRequest
  },
  {
    name: 'Multi-Line Context Change',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 3,
      commit_sha: 'main',
      file: 'multi_context.ts',
      start_line: 1,
      end_line: 5,
      content: multiLineChangeContent,
      diff_hunk: `@@ -1,8 +1,8 @@
-function processUserData(userData) {
+// Update the function signature and implementation
+async function processUserData(userData, options = {}) {
   // old implementation
-  return userData;
-}
+  const { timeout = 5000, retries = 3 } = options;`,
    } as PatchRequest
  },
  {
    name: 'Complex Diff Hunk',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 4,
      commit_sha: 'main',
      file: 'complex.ts',
      start_line: 10,
      end_line: 25,
      content: 'Update the calculation logic',
      diff_hunk: complexDiffHunk,
    } as PatchRequest
  },
  {
    name: 'Nested Structure Changes',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 5,
      commit_sha: 'main',
      file: 'nested.ts',
      start_line: 1,
      end_line: 15,
      content: nestedStructureContent,
      diff_hunk: `@@ -1,18 +1,28 @@
-function oldLogic(user) {
+// Fix the nested conditional logic
+if (user && user.profile) {
+  if (user.profile.settings) {
+    if (user.profile.settings.notifications) {
+      // Process notifications
+      handleNotifications(user.profile.settings.notifications);
+    } else {
+      // Default notification settings
+      handleNotifications(DEFAULT_NOTIFICATIONS);
+    }
+  } else {
+    // Default settings
+    handleNotifications(DEFAULT_SETTINGS);
+  }
+} else {
+  // Anonymous user
+  handleNotifications(ANONYMOUS_SETTINGS);
+}`,
    } as PatchRequest
  },
  {
    name: 'Import Statement Addition',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 6,
      commit_sha: 'main',
      file: 'imports.ts',
      start_line: 1,
      end_line: 3,
      content: importAdditionContent,
      diff_hunk: `@@ -1,5 +1,8 @@
-import { oldFunction } from './utils';
+// Add the missing import for the utility function
+import { validateInput, sanitizeData } from './utils/validation';
+import { processData } from './utils/processing';
+import { DEFAULT_CONFIG } from './config';
 
-export function handler(data) { return oldFunction(data); }
+export async function handleRequest(req, res) {`,
    } as PatchRequest
  },
  {
    name: 'Advanced LLM - Type 1: Complex Algorithm Refactor',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 7,
      commit_sha: 'main',
      file: 'algorithm.ts',
      start_line: 15,
      end_line: 35,
      content: `The current sorting algorithm has O(n^2) complexity. Refactor to use merge sort for better performance.

\`\`\`suggestion
function mergeSort(arr) {
  if (arr.length <= 1) {
    return arr;
  }
  
  const mid = Math.floor(arr.length / 2);
  const left = mergeSort(arr.slice(0, mid));
  const right = mergeSort(arr.slice(mid));
  
  return merge(left, right);
}

function merge(left, right) {
  let result = [];
  let leftIndex = 0;
  let rightIndex = 0;
  
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] < right[rightIndex]) {
      result.push(left[leftIndex]);
      leftIndex++;
    } else {
      result.push(right[rightIndex]);
      rightIndex++;
    }
  }
  
  return result.concat(left.slice(leftIndex)).concat(right.slice(rightIndex));
}

// Updated function using merge sort
export function sortData(data) {
  return mergeSort([...data]); // Create a copy to avoid mutating original
}
\`\`\``,
      diff_hunk: `@@ -15,20 +15,35 @@
-function sortData(data) {
-  // Current implementation uses bubble sort - inefficient
-  for (let i = 0; i < data.length; i++) {
-    for (let j = 0; j < data.length - i - 1; j++) {
-      if (data[j] > data[j + 1]) {
-        [data[j], data[j + 1]] = [data[j + 1], data[j]];
-      }
-    }
-  }
-  return data;
-}
+// The current sorting algorithm has O(n^2) complexity. Refactor to use merge sort for better performance.
+function mergeSort(arr) {
+  if (arr.length <= 1) {
+    return arr;
+  }
+  
+  const mid = Math.floor(arr.length / 2);
+  const left = mergeSort(arr.slice(0, mid));
+  const right = mergeSort(arr.slice(mid));
+  
+  return merge(left, right);
+}
+
+function merge(left, right) {
+  let result = [];
+  let leftIndex = 0;
+  let rightIndex = 0;
+  
+  while (leftIndex < left.length && rightIndex < right.length) {
+    if (left[leftIndex] < right[rightIndex]) {
+      result.push(left[leftIndex]);
+      leftIndex++;
+    } else {
+      result.push(right[rightIndex]);
+      rightIndex++;
+    }
+  }
+  
+  return result.concat(left.slice(leftIndex)).concat(right.slice(rightIndex));
+}
+
+// Updated function using merge sort
+export function sortData(data) {
+  return mergeSort([...data]); // Create a copy to avoid mutating original
+}`,
    } as PatchRequest
  },
  {
    name: 'Advanced LLM - Type 2: Security Vulnerability Fix',
    request: {
      repo: 'pr-autopilot/test-repo',
      pr: 8,
      commit_sha: 'main',
      file: 'security.ts',
      start_line: 8,
      end_line: 20,
      content: `This code is vulnerable to XSS attacks. Sanitize user input before inserting into DOM.

\`\`\`suggestion
import { sanitizeHTML } from 'dompurify';

export function displayUserContent(content) {
  // Sanitize user content to prevent XSS
  const sanitizedContent = sanitizeHTML(content);
  
  // Additional validation
  if (typeof sanitizedContent !== 'string' || sanitizedContent.length > 10000) {
    throw new Error('Invalid content provided');
  }
  
  // Safe insertion into DOM
  document.getElementById('content-display').innerHTML = sanitizedContent;
}

// Alternative implementation using template literals with sanitization
export function displayUserContentSafe(content) {
  // Validate input
  if (!content || typeof content !== 'string') {
    console.warn('Invalid content provided to displayUserContentSafe');
    return;
  }
  
  // Sanitize content
  const div = document.createElement('div');
  div.textContent = content; // This escapes HTML
  const sanitized = div.innerHTML;
  
  // Insert safely
  const targetEl = document.getElementById('content-display');
  if (targetEl) {
    targetEl.textContent = ''; // Clear existing content
    targetEl.appendChild(document.createTextNode(sanitized)); // Add sanitized content
  }
}
\`\`\``,
      diff_hunk: `@@ -8,15 +8,40 @@
-export function displayUserContent(content) {
-  // Vulnerable: directly inserting user content into DOM
-  document.getElementById('content-display').innerHTML = content;
-}
+// This code is vulnerable to XSS attacks. Sanitize user input before inserting into DOM.
+import { sanitizeHTML } from 'dompurify';
+
+export function displayUserContent(content) {
+  // Sanitize user content to prevent XSS
+  const sanitizedContent = sanitizeHTML(content);
+  
+  // Additional validation
+  if (typeof sanitizedContent !== 'string' || sanitizedContent.length > 10000) {
+    throw new Error('Invalid content provided');
+  }
+  
+  // Safe insertion into DOM
+  document.getElementById('content-display').innerHTML = sanitizedContent;
+}
+
+// Alternative implementation using template literals with sanitization
+export function displayUserContentSafe(content) {
+  // Validate input
+  if (!content || typeof content !== 'string') {
+    console.warn('Invalid content provided to displayUserContentSafe');
+    return;
+  }
+  
+  // Sanitize content
+  const div = document.createElement('div');
+  div.textContent = content; // This escapes HTML
+  const sanitized = div.innerHTML;
+  
+  // Insert safely
+  const targetEl = document.getElementById('content-display');
+  if (targetEl) {
+    targetEl.textContent = ''; // Clear existing content
+    targetEl.appendChild(document.createTextNode(sanitized)); // Add sanitized content
+  }
+}`,
    } as PatchRequest
  }
];

async function runTest(scenario, level: number) {
  console.log(`\n--- Testing ${scenario.name} (Level ${level}) ---`);
  
  const generator = new PatchGenerator();
  
  try {
    const result = await generator.generatePatch(scenario.request, level);
    
    console.log(`Success: ${result.success}`);
    console.log(`Requires approval: ${result.requires_approval}`);
    
    if (result.error) {
      console.log(`Error: ${result.error}`);
    }
    
    if (result.patch) {
      console.log('Generated patch:');
      console.log(result.patch.substring(0, 500) + (result.patch.length > 500 ? '...' : ''));
    }
    
    return result;
  } catch (error) {
    console.error(`Test failed with exception:`, error);
    return { success: false, error: error.message };
  } finally {
    generator.cleanup();
  }
}

async function main() {
  console.log('========================================');
  console.log('ADVANCED PATCH GENERATION TEST SUITE');
  console.log('========================================\n');

  // Test both Level 1 (mechanical) and Level 2 (LLM-assisted) for each scenario
  for (const scenario of testScenarios) {
    console.log(`\n>>>>>>> Testing Scenario: ${scenario.name} <<<<<<<`);
    
    // Test Level 1
    const result1 = await runTest(scenario, 1);
    
    // Test Level 2
    const result2 = await runTest(scenario, 2);
    
    console.log(`\nLevel 1 - Success: ${result1.success}, Errors: ${!!result1.error}`);
    console.log(`Level 2 - Success: ${result2.success}, Errors: ${!!result2.error}`);
  }

  console.log('\n========================================');
  console.log('ADVANCED TEST SUITE COMPLETE');
  console.log('========================================');
  
  // Summary statistics
  console.log('\nSUMMARY:');
  console.log(`Total scenarios tested: ${testScenarios.length}`);
  console.log(`Each scenario tested at 2 levels: 1 (mechanical) and 2 (LLM-assisted)`);
  console.log(`Total test runs: ${testScenarios.length * 2}`);
}

main().catch(console.error);