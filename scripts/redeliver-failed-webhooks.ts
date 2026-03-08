#!/usr/bin/env tsx
/**
 * GitHub Webhook Redelivery Script
 *
 * Redelivers all failed webhook deliveries (521 errors and orange "could not deliver" failures)
 * for GitHub Apps or personal repositories.
 *
 * Usage: tsx redeliver-failed-webhooks.ts
 *
 * Authentication (choose one):
 *   Option 1 - GitHub App:
 *     GITHUB_APP_ID - Your GitHub App ID (numeric)
 *     GITHUB_PRIVATE_KEY - Your App's private key (PEM content)
 *     GITHUB_APP_INSTALLATION_ID - Installation ID
 *
 *   Option 2 - Personal Access Token:
 *     GITHUB_TOKEN - Your PAT with repo permissions
 *     GITHUB_OWNER - Repository owner (username or org)
 *     GITHUB_REPO - Repository name
 *     GITHUB_HOOK_ID - Webhook ID (from repo settings/hooks URL)
 *
 * Optional environment variables:
 *   GITHUB_WEBHOOK_EVENT - Filter by event type (e.g., "issue_comment")
 *   MAX_DELIVERIES - Max deliveries to process (0 = unlimited)
 *   REDELIVER_DELAY_MS - Delay between requests in ms (default: 100)
 *   SINCE_DATE - Only redeliver deliveries newer than this (ISO date)
 *   AUTO_CONFIRM - Auto-confirm without prompting ("true" for CI)
 */

import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
<<<<<<< Updated upstream
=======
import * as fs from "fs";
>>>>>>> Stashed changes

// ============================================================================
// CONFIGURATION - Environment variables follow project conventions
// ============================================================================
const CONFIG = {

  // Force PAT auth even if App vars are set (optional)
  usePat: process.env.USE_PAT_AUTH === "true",
  
  // GitHub App authentication (optional)
  appId: process.env.GITHUB_APP_ID ? parseInt(process.env.GITHUB_APP_ID, 10) : undefined,
  privateKey: process.env.GITHUB_PRIVATE_KEY || "",
  privateKeyPath: process.env.GITHUB_PRIVATE_KEY_PATH || "",
  installationId: process.env.GITHUB_APP_INSTALLATION_ID 
    ? parseInt(process.env.GITHUB_APP_INSTALLATION_ID, 10) 
    : undefined,

  // Personal Access Token authentication (optional)
  token: process.env.GITHUB_TOKEN || "",
  owner: process.env.GITHUB_OWNER || "",
  repo: process.env.GITHUB_REPO || "",
  hookId: process.env.GITHUB_HOOK_ID || "",

  // Optional settings
  eventType: process.env.GITHUB_WEBHOOK_EVENT || "",
  maxDeliveries: parseInt(process.env.MAX_DELIVERIES || "0", 10),
  delayMs: parseInt(process.env.REDELIVER_DELAY_MS || "100", 10),
  sinceDate: process.env.SINCE_DATE || "",
  autoConfirm: process.env.AUTO_CONFIRM === "true",
};

// ============================================================================
// Validation
// ============================================================================
function validateConfig() {
  const errors: string[] = [];

<<<<<<< Updated upstream
  const hasAppAuth = !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
=======
  // Load private key from file if path is set and content is empty/invalid
  if (CONFIG.privateKeyPath && (!CONFIG.privateKey || CONFIG.privateKey.length < 50)) {
    try {
      CONFIG.privateKey = fs.readFileSync(CONFIG.privateKeyPath, 'utf8');
      console.log("[DEBUG] Loaded private key from:", CONFIG.privateKeyPath);
    } catch (err: any) {
      errors.push(`Cannot read private key file: ${CONFIG.privateKeyPath} - ${err.message}`);
    }
  }

  const hasAppAuth = !CONFIG.usePat && !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
>>>>>>> Stashed changes
  const hasPatAuth = !!(CONFIG.token && CONFIG.owner && CONFIG.repo && CONFIG.hookId);

  if (!hasAppAuth && !hasPatAuth) {
    errors.push(
      "Authentication required. Choose one:\n" +
      "  GitHub App: GITHUB_APP_ID + GITHUB_PRIVATE_KEY + GITHUB_APP_INSTALLATION_ID\n" +
<<<<<<< Updated upstream
      "  PAT: GITHUB_TOKEN + GITHUB_OWNER + GITHUB_REPO + GITHUB_HOOK_ID"
    );
  }

  if (hasAppAuth && hasPatAuth) {
    errors.push("Both GitHub App and PAT auth configured. Please use only one.");
=======
      "  PAT: GITHUB_TOKEN + GITHUB_OWNER + GITHUB_REPO + GITHUB_HOOK_ID\n" +
      "  Or set USE_PAT_AUTH=true to force PAT mode"
    );
  }

  if (hasAppAuth && hasPatAuth && !CONFIG.usePat) {
    console.warn("⚠️  Both GitHub App and PAT auth configured. Using PAT (set USE_PAT_AUTH=true to confirm).");
>>>>>>> Stashed changes
  }

  if (errors.length > 0) {
    console.error("❌ Configuration errors:");
    errors.forEach((e) => console.error(`   - ${e}`));
    console.error("\n📝 Set the required environment variables and run again.");
    process.exit(1);
  }
}

// ============================================================================
// Initialize Octokit with appropriate authentication
// ============================================================================
function createOctokit(): Octokit {
<<<<<<< Updated upstream
  const hasAppAuth = !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);

  if (hasAppAuth) {
    // Normalize the private key: replace escaped newlines and ensure proper PEM format
    const privateKey = CONFIG.privateKey
      .replace(/\\n/g, '\n')
      .trim();
=======
  const hasAppAuth = !CONFIG.usePat && !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);

  if (hasAppAuth) {
    // Normalize the private key: handle various formats
    let privateKey = CONFIG.privateKey;
    
    // Replace escaped newlines
    privateKey = privateKey.replace(/\\n/g, '\n');
    
    // Fix common formatting issues
    // Add newline before -----END if missing (e.g., "base64data -----END" -> "base64data\n-----END")
    privateKey = privateKey.replace(/([A-Za-z0-9+/=])\s+-----END/, '$1\n-----END');
    
    // Fix malformed headers/footers with missing spaces
    privateKey = privateKey.replace(/-----BEGINRSA/, '-----BEGIN RSA ');
    privateKey = privateKey.replace(/-----ENDRSA/, '-----END RSA ');
    privateKey = privateKey.replace(/RSA\s+PRIVATE\s+KEY-----/, 'RSA PRIVATE KEY-----');
    
    // If key is on one line with spaces, restore proper PEM format
    if (privateKey.includes(' ') && !privateKey.includes('\n')) {
      // Split by spaces to get individual chunks
      const chunks = privateKey.split(/\s+/);
      
      const lines = [];
      let currentLine = '';
      
      for (const chunk of chunks) {
        // Fix malformed headers/footers
        let processedChunk = chunk;
        if (chunk.includes('-----BEGIN') && !chunk.includes(' ')) {
          processedChunk = '-----BEGIN RSA PRIVATE KEY-----';
        } else if (chunk.includes('-----END') && !chunk.includes(' ')) {
          processedChunk = '-----END RSA PRIVATE KEY-----';
        }
        
        if (processedChunk.startsWith('-----')) {
          // Header or footer - always on its own line
          if (currentLine) lines.push(currentLine);
          lines.push(processedChunk);
          currentLine = '';
        } else {
          // Base64 content - only keep valid base64 chars
          const cleanChunk = processedChunk.replace(/[^A-Za-z0-9+/=]/g, '');
          currentLine += cleanChunk;
          if (currentLine.length >= 64) {
            lines.push(currentLine);
            currentLine = '';
          }
        }
      }
      if (currentLine) lines.push(currentLine);
      privateKey = lines.join('\n');
    }
    
    privateKey = privateKey.trim();
>>>>>>> Stashed changes

    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: CONFIG.appId,
        privateKey,
        installationId: CONFIG.installationId,
      },
    });
  } else {
    // Personal Access Token
    return new Octokit({
      auth: CONFIG.token,
    });
  }
}

// ============================================================================
// Check if a delivery should be redelivered
// ============================================================================
function isFailedDelivery(delivery: {
  status_code: number | null;
  status: string | null;
  event: string;
  delivered_at: string;
}): boolean {
  // 521 = Web Server is Down (Cloudflare error)
  if (delivery.status_code === 521) {
    return true;
  }
  
  // Orange "could not deliver" - no status code or failed status
  if (!delivery.status_code || delivery.status === "failed") {
    return true;
  }
  
  // Other error status codes (4xx, 5xx)
  if (delivery.status_code && delivery.status_code >= 400) {
    return true;
  }
  
  return false;
}

// ============================================================================
// Get failure reason for logging
// ============================================================================
function getFailureReason(delivery: {
  status_code: number | null;
  status: string | null;
  response: string | null;
}): string {
  if (delivery.status_code === 521) {
    return "521 - Web Server Down (Cloudflare)";
  }
  
  if (!delivery.status_code) {
    return "No response (DNS/Connection failure)";
  }
  
  if (delivery.status === "failed") {
    return `Failed (HTTP ${delivery.status_code})`;
  }
  
  if (delivery.status_code >= 500) {
    return `Server Error (HTTP ${delivery.status_code})`;
  }
  
  if (delivery.status_code >= 400) {
    return `Client Error (HTTP ${delivery.status_code})`;
  }
  
  return `Unknown (HTTP ${delivery.status_code})`;
}

// ============================================================================
// Fetch all deliveries with pagination
// ============================================================================
async function fetchAllDeliveries(octokit: Octokit): Promise<any[]> {
  const allDeliveries: any[] = [];
  let page = 1;
  const perPage = 100; // Max allowed by GitHub API

<<<<<<< Updated upstream
  const hasAppAuth = !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
=======
  const hasAppAuth = !CONFIG.usePat && !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
>>>>>>> Stashed changes
  const endpoint = hasAppAuth 
    ? "GET /app/hook/deliveries" 
    : `GET /repos/{owner}/{repo}/hooks/{hook_id}/deliveries`;

  console.log("📥 Fetching webhook deliveries...");

  while (true) {
    try {
      const params: any = {
        per_page: perPage,
        page,
      };

      if (!hasAppAuth) {
        params.owner = CONFIG.owner;
        params.repo = CONFIG.repo;
        params.hook_id = CONFIG.hookId;
      }

      const response = await octokit.request(endpoint, params);
      const deliveries = response.data;

      if (deliveries.length === 0) {
        break;
      }

      // Filter by event type if specified
      let filtered = deliveries;
      if (CONFIG.eventType) {
        filtered = deliveries.filter((d: any) => d.event === CONFIG.eventType);
      }

      // Filter by date if specified
      if (CONFIG.sinceDate) {
        const since = new Date(CONFIG.sinceDate);
        filtered = filtered.filter((d: any) => new Date(d.delivered_at) >= since);
      }

      allDeliveries.push(...filtered);

      console.log(
        `   Page ${page}: ${deliveries.length} deliveries (${filtered.length} after filters)`
      );

      // If we got fewer than perPage, we've reached the end
      if (deliveries.length < perPage) {
        break;
      }

      // Safety limit for unlimited runs
      if (CONFIG.maxDeliveries > 0 && allDeliveries.length >= CONFIG.maxDeliveries) {
        console.log(`   ⚠️  Reached max deliveries limit (${CONFIG.maxDeliveries})`);
        break;
      }

      page++;

      // Small delay to be nice to the API
      await new Promise((r) => setTimeout(r, 50));
    } catch (error: any) {
      console.error(`❌ Error fetching page ${page}:`, error.message);
      break;
    }
  }

  return allDeliveries;
}

// ============================================================================
// Redeliver a single delivery
// ============================================================================
async function redeliver(
  octokit: Octokit,
  deliveryId: number,
  attempt: number = 1
): Promise<boolean> {
<<<<<<< Updated upstream
  const hasAppAuth = !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
=======
  const hasAppAuth = !CONFIG.usePat && !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
>>>>>>> Stashed changes
  const endpoint = hasAppAuth
    ? "POST /app/hook/deliveries/{delivery_id}/attempts"
    : `POST /repos/{owner}/{repo}/hooks/{hook_id}/deliveries/{delivery_id}/attempts`;

  try {
    const params: any = { delivery_id: deliveryId };
    if (!hasAppAuth) {
      params.owner = CONFIG.owner;
      params.repo = CONFIG.repo;
      params.hook_id = CONFIG.hookId;
    }

    await octokit.request(endpoint, params);
    return true;
  } catch (error: any) {
    // Retry once on rate limit
    if (error.status === 403 && attempt === 1) {
      console.log(`   ⏳ Rate limited, waiting 5 seconds...`);
      await new Promise((r) => setTimeout(r, 5000));
      return redeliver(octokit, deliveryId, attempt + 1);
    }

    console.error(`   ❌ Redelivery failed: ${error.message}`);
    return false;
  }
}

// ============================================================================
// Main execution
// ============================================================================
async function main() {
<<<<<<< Updated upstream
  const hasAppAuth = !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
  
  console.log("🔧 GitHub Webhook Redelivery Tool\n");
  console.log("Authentication:");
  if (hasAppAuth) {
=======
  const hasAppAuth = !CONFIG.usePat && !!(CONFIG.appId && CONFIG.privateKey && CONFIG.installationId);
  const hasPatAuth = !!(CONFIG.token && CONFIG.owner && CONFIG.repo && CONFIG.hookId);

  console.log("🔧 GitHub Webhook Redelivery Tool\n");
  console.log("Authentication:");
  if (hasAppAuth && !CONFIG.usePat) {
>>>>>>> Stashed changes
    console.log("   Mode: GitHub App");
    console.log(`   App ID: ${CONFIG.appId}`);
    console.log(`   Installation ID: ${CONFIG.installationId}`);
    console.log(`   Private Key: [configured]`);
<<<<<<< Updated upstream
  } else {
=======
  } else if (hasPatAuth) {
>>>>>>> Stashed changes
    console.log("   Mode: Personal Access Token");
    console.log(`   Owner: ${CONFIG.owner}`);
    console.log(`   Repo: ${CONFIG.repo}`);
    console.log(`   Hook ID: ${CONFIG.hookId}`);
<<<<<<< Updated upstream
=======
  } else if (CONFIG.usePat && !hasPatAuth) {
    console.log("   Mode: Personal Access Token (forced)");
    console.log("   ⚠️  Missing PAT credentials (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_HOOK_ID)");
>>>>>>> Stashed changes
  }
  console.log("");
  
  if (CONFIG.eventType) {
    console.log(`   Event Filter: ${CONFIG.eventType}`);
  }
  if (CONFIG.maxDeliveries > 0) {
    console.log(`   Max Deliveries: ${CONFIG.maxDeliveries}`);
  }
  if (CONFIG.delayMs > 0) {
    console.log(`   Delay: ${CONFIG.delayMs}ms`);
  }
  if (CONFIG.sinceDate) {
    console.log(`   Since: ${CONFIG.sinceDate}`);
  }
  if (CONFIG.autoConfirm) {
    console.log(`   Auto Confirm: yes`);
  }
  console.log("");
  
  validateConfig();
  
  const octokit = createOctokit();
  
  // Fetch all deliveries
  const deliveries = await fetchAllDeliveries(octokit);
  console.log(`\n📊 Total deliveries fetched: ${deliveries.length}`);
  
  // Filter for failures
  const failedDeliveries = deliveries.filter(isFailedDelivery);
  console.log(`⚠️  Failed deliveries found: ${failedDeliveries.length}`);
  
  if (failedDeliveries.length === 0) {
    console.log("\n✅ No failed deliveries to redeliver!");
    return;
  }
  
  // Show summary of failure types
  const failureTypes = new Map<string, number>();
  failedDeliveries.forEach((d) => {
    const reason = getFailureReason(d);
    failureTypes.set(reason, (failureTypes.get(reason) || 0) + 1);
  });
  
  console.log("\n📋 Failure breakdown:");
  failureTypes.forEach((count, reason) => {
    console.log(`   ${reason}: ${count}`);
  });
  
  // Confirm before proceeding
  console.log(`\n❓ Redeliver ${failedDeliveries.length} failed webhooks? (y/n)`);
  
  // Non-interactive mode if running in CI
  if (CONFIG.autoConfirm) {
    console.log("   AUTO_CONFIRM=true, proceeding...\n");
  } else {
    const answer = await new Promise<string>((resolve) => {
      process.stdin.once("data", (data) => resolve(data.toString().trim().toLowerCase()));
      setTimeout(() => resolve("n"), 10000); // Timeout after 10 seconds
    });
    
    if (answer !== "y" && answer !== "yes") {
      console.log("❌ Cancelled.");
      return;
    }
    console.log("");
  }
  
  // Redeliver failures
  let successCount = 0;
  let failCount = 0;
  const results: Array<{ id: number; event: string; reason: string; success: boolean; error?: string }> = [];

  console.log("🚀 Starting redelivery...\n");

  for (const delivery of failedDeliveries) {
    const reason = getFailureReason(delivery);
    const startTime = Date.now();
    
    console.log(
      `[${delivery.id}] ${reason} - Event: ${delivery.event} - ${delivery.delivered_at}`
    );

    const success = await redeliver(octokit, delivery.id);
    const duration = Date.now() - startTime;

    if (success) {
      console.log(`   ✅ Redelivered successfully (${duration}ms)`);
      successCount++;
      results.push({ id: delivery.id, event: delivery.event, reason, success: true });
    } else {
      console.log(`   ❌ Redelivery failed (${duration}ms)`);
      failCount++;
      results.push({ id: delivery.id, event: delivery.event, reason, success: false });
    }

    // Delay between requests
    if (CONFIG.delayMs > 0) {
      await new Promise((r) => setTimeout(r, CONFIG.delayMs));
    }
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("📊 Redelivery Summary:");
  console.log(`   ✅ Successful: ${successCount}`);
  console.log(`   ❌ Failed: ${failCount}`);
  console.log(`   📦 Total: ${failedDeliveries.length}`);
  console.log("=".repeat(50));
  
  // Detailed results
  if (results.length > 0) {
    console.log("\n📋 Detailed Results:");
    
    // Show failures first
    const failures = results.filter(r => !r.success);
    if (failures.length > 0) {
      console.log("\n   ❌ Failures:");
      failures.forEach(r => {
        console.log(`      [${r.id}] ${r.event} - ${r.reason}`);
      });
    }
    
    // Show successes
    const successes = results.filter(r => r.success);
    if (successes.length > 0) {
      console.log("\n   ✅ Successes:");
      successes.forEach(r => {
        console.log(`      [${r.id}] ${r.event} - ${r.reason}`);
      });
    }
  }
}

// Run
main().catch((error) => {
  console.error("💥 Fatal error:", error);
  process.exit(1);
});
