#!/usr/bin/env tsx
/**
 * Check and fix GitHub App private key format
 * 
 * Usage: tsx scripts/check-key-format.ts
 */

const privateKey = process.env.GITHUB_PRIVATE_KEY || "";

if (!privateKey) {
  console.log("❌ GITHUB_PRIVATE_KEY not set");
  process.exit(1);
}

console.log("🔍 Analyzing private key format...\n");

// Check format
const hasNewlines = privateKey.includes('\n');
const hasSpaces = privateKey.includes(' ');
const hasEscapedNewlines = privateKey.includes('\\n');
const startsCorrectly = privateKey.startsWith('-----BEGIN');
const endsCorrectly = privateKey.trim().endsWith('-----END RSA PRIVATE KEY-----') || 
                      privateKey.trim().endsWith('-----END PRIVATE KEY-----');

console.log("Format analysis:");
console.log(`   Has newlines: ${hasNewlines ? '✅ Yes' : '❌ No'}`);
console.log(`   Has spaces: ${hasSpaces ? '⚠️  Yes (may need fixing)' : '✅ No'}`);
console.log(`   Has escaped newlines (\\n): ${hasEscapedNewlines ? '⚠️  Yes' : '✅ No'}`);
console.log(`   Starts with header: ${startsCorrectly ? '✅ Yes' : '❌ No'}`);
console.log(`   Ends with footer: ${endsCorrectly ? '✅ Yes' : '❌ No'}`);

// Check if it looks like a valid PEM key
const pemPattern = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]*-----END (?:RSA )?PRIVATE KEY-----/;
const isValidPEM = pemPattern.test(privateKey.replace(/\s+/g, ' '));

console.log(`\n   Valid PEM structure: ${isValidPEM ? '✅ Yes' : '❌ No'}`);

// Count lines (if multiline)
const lines = privateKey.split('\n').filter(l => l.trim());
console.log(`   Content lines: ${lines.length}`);

// Show first/last chars (safe)
const trimmed = privateKey.trim();
console.log(`   First 30 chars: ${trimmed.slice(0, 30)}...`);
console.log(`   Last 30 chars: ...${trimmed.slice(-30)}`);

// Determine if fix needed
const needsFix = !hasNewlines && hasSpaces;

console.log("\n" + "=".repeat(50));
if (needsFix) {
  console.log("⚠️  Key appears to be on one line with spaces");
  console.log("\n📝 To fix, use one of these methods:\n");
  
  console.log("Method 1 - Using the redeliver script (auto-fixes):");
  console.log("   The redeliver script now handles single-line keys automatically.\n");
  
  console.log("Method 2 - Fix the env var manually:");
  console.log("   Use the normalization helper from scripts/redeliver-failed-webhooks.ts:");
  console.log("   export GITHUB_PRIVATE_KEY=$(npx tsx scripts/redeliver-failed-webhooks.ts normalize-key \"$GITHUB_PRIVATE_KEY\")\n");

  console.log("Method 3 - Use a file with the normalization helper:");
  console.log("   echo \"$GITHUB_PRIVATE_KEY\" | npx tsx scripts/redeliver-failed-webhooks.ts normalize-key - > github-key.pem");
  console.log("   export GITHUB_PRIVATE_KEY=$(cat github-key.pem)\n");
  
  // Show fixed version
  console.log("\n📋 Fixed key preview:");
  const keyWithoutSpaces = privateKey.replace(/\s+/g, '');
  const fixedLines = [];
  let buffer = '';
  
  for (let i = 0; i < keyWithoutSpaces.length; i += 64) {
    const chunk = keyWithoutSpaces.slice(i, i + 64);
    if (chunk.startsWith('-----')) {
      if (buffer) fixedLines.push(buffer);
      fixedLines.push(chunk);
      buffer = '';
    } else {
      buffer += chunk;
    }
  }
  if (buffer) fixedLines.push(buffer);
  
  console.log("   " + fixedLines.slice(0, 3).join('\n   '));
  console.log("   ...");
  console.log("   " + fixedLines.slice(-2).join('\n   '));
} else {
  console.log("✅ Key format looks correct!");
}

console.log("=".repeat(50));
