#!/usr/bin/env bun
/**
 * Advanced test suite for PatchGenerator - Direct LLM Call Tests
 * Focus: Making actual LLM calls using callLLM method
 */

import * as fs from 'fs';
import * as path from 'path';
import { PatchGenerator } from './scripts/patch-generator';
import { PatchRequest, PatchResult } from './scripts/types';

const targetFile = 'test-intricate-diffs.ts';
const targetPath = path.join(process.cwd(), targetFile);

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

async function runDirectLLMCall(
  generator: PatchGenerator,
  testName: string,
  prompt: string
): Promise<{ success: boolean; output?: string; error?: string }> {
  console.log(`\n--- Direct LLM Call: ${testName} ---`);

  const anyGenerator = generator as unknown as {
    callLLM?: (p: string, r?: PatchRequest) => Promise<{ success: boolean; output?: string; error?: string }>;
  };

  if (!anyGenerator.callLLM) {
    return { success: false, error: 'callLLM not available on PatchGenerator' };
  }

  return anyGenerator.callLLM(prompt);
}

async function main() {
  console.log('========================================');
  console.log('DIRECT LLM CALL TEST SUITE');
  console.log('========================================\n');

  loadEnvFile(path.join(process.cwd(), '.env'));

  if (!fs.existsSync(targetPath)) {
    throw new Error(`Target file not found: ${targetPath}`);
  }

  const runLLMTests =
    process.env.RUN_LLM_TESTS === 'true' &&
    (!!process.env.GEMINI_API_KEY || !!process.env.MISTRAL_API_KEY || process.env.ALLOW_QWEN === 'true');

  if (!runLLMTests) {
    console.log('Skipped: set RUN_LLM_TESTS=true and configure GEMINI_API_KEY, MISTRAL_API_KEY, or ALLOW_QWEN=true.');
    process.exit(0);
  }

  const generator = new PatchGenerator();

  try {
    // Test 1: Simple smoke test
    const smokeResult = await runDirectLLMCall(
      generator,
      'Smoke Test',
      'Respond with a single line: OK'
    );
    console.log(`Success: ${smokeResult.success}`);
    if (smokeResult.error) console.log(`Error: ${smokeResult.error}`);
    if (smokeResult.output) console.log(`Output: ${smokeResult.output.trim()}`);

    // Test 2: Diff generation prompt
    const diffPrompt = `Generate a unified diff for changing line 711 from:
  console.log('INTRICATE DIFF GENERATION TEST SUITE');
to:
  console.log('INTRICATE DIFF GENERATION TEST SUITE (ADVANCED)');

Respond with just the diff in this format:
@@ -711,1 +711,1 @@
-  console.log('INTRICATE DIFF GENERATION TEST SUITE');
+  console.log('INTRICATE DIFF GENERATION TEST SUITE (ADVANCED)');`;

    const diffResult = await runDirectLLMCall(
      generator,
      'Diff Generation',
      diffPrompt
    );
    console.log(`Success: ${diffResult.success}`);
    if (diffResult.error) console.log(`Error: ${diffResult.error}`);
    if (diffResult.output) console.log(`Output:\n${diffResult.output.trim()}`);

    // Test 3: Complex scenario with content
    const complexPrompt = `Create a patch suggestion for a Python function call. The original code is:
result = some_function(
    arg1,
    arg2,
    arg3)

Add a fourth argument arg4 while preserving indentation. Output just the unified diff.`;

    const complexResult = await runDirectLLMCall(
      generator,
      'Complex Scenario - Python Function Arguments',
      complexPrompt
    );
    console.log(`Success: ${complexResult.success}`);
    if (complexResult.error) console.log(`Error: ${complexResult.error}`);
    if (complexResult.output) console.log(`Output:\n${complexResult.output.trim()}`);

    // Test 4: JSON nested structure change
    const jsonPrompt = `Create a unified diff for changing a JSON nested structure. Original:
{
    "user": {
        "name": "Alice",
        "preferences": {
            "theme": "dark"
        }
    }
}

Change "theme": "dark" to "theme": "light" and add "language": "en". Output just the diff.`;

    const jsonResult = await runDirectLLMCall(
      generator,
      'Complex Scenario - JSON Nested Structure',
      jsonPrompt
    );
    console.log(`Success: ${jsonResult.success}`);
    if (jsonResult.error) console.log(`Error: ${jsonResult.error}`);
    if (jsonResult.output) console.log(`Output:\n${jsonResult.output.trim()}`);

    // Test 5: Unicode/emoji replacement
    const unicodePrompt = `Create a unified diff for changing "Hello, world!" to "Hello, 🌍!". Output just the diff.`;

    const unicodeResult = await runDirectLLMCall(
      generator,
      'Complex Scenario - Unicode Replacement',
      unicodePrompt
    );
    console.log(`Success: ${unicodeResult.success}`);
    if (unicodeResult.error) console.log(`Error: ${unicodeResult.error}`);
    if (unicodeResult.output) console.log(`Output:\n${unicodeResult.output.trim()}`);

    // Test 6: Semantic renaming
    const semanticPrompt = `Create a unified diff for semantically renaming variables in Python. Original:
def calculate_total(price, quantity):
    return price * quantity

Rename price to unit_price and quantity to units. Output just the diff.`;

    const semanticResult = await runDirectLLMCall(
      generator,
      'Complex Scenario - Semantic Renaming',
      semanticPrompt
    );
    console.log(`Success: ${semanticResult.success}`);
    if (semanticResult.error) console.log(`Error: ${semanticResult.error}`);
    if (semanticResult.output) console.log(`Output:\n${semanticResult.output.trim()}`);

  } finally {
    generator.cleanup();
  }

  console.log('\n========================================');
  console.log('DIRECT LLM CALL TEST COMPLETE');
  console.log('========================================');
}

main().catch((error) => {
  console.error('Direct LLM test failed:', error);
  process.exit(1);
});
