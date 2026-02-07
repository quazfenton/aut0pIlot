#!/usr/bin/env node

/**
 * Test script to verify PR Autopilot agent processes webhooks correctly
 */

const TEST_WEBHOOK_SECRET = 'test-secret';

const testPayloads = {
  // Test 1: pull_request_review_comment
  reviewComment: {
    action: 'created',
    comment: {
      id: 123456789,
      body: 'This should be fixed - use const instead of let',
      path: 'src/test.js',
      line: 10,
      commit_id: 'abc123def456',
      user: {
        login: 'test-user'
      }
    },
    repository: {
      full_name: 'test-org/test-repo'
    },
    pull_request: {
      number: 42,
      head: {
        sha: 'abc123def456',
        ref: 'feature-branch'
      }
    }
  },

  // Test 2: pull_request_review (submitted)
  reviewSubmitted: {
    action: 'submitted',
    review: {
      id: 987654321,
      body: 'Please fix the formatting issues',
      user: {
        login: 'coderabbit[bot]',
        type: 'Bot'
      },
      commit_id: 'def789abc012'
    },
    repository: {
      full_name: 'test-org/test-repo'
    },
    pull_request: {
      number: 42,
      head: {
        sha: 'def789abc012',
        ref: 'feature-branch'
      }
    }
  },

  // Test 3: pull_request (opened) - should reset state only
  prOpened: {
    action: 'opened',
    repository: {
      full_name: 'test-org/test-repo'
    },
    number: 42,
    pull_request: {
      number: 42
    }
  }
};

async function sendWebhook(eventType, payload) {
  const payloadString = JSON.stringify(payload);
  
  console.log(`\n=== Testing ${eventType} ===`);
  console.log('Payload:', payloadString.substring(0, 200) + '...');
  
  try {
    const response = await fetch('http://localhost:3000/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': eventType,
        'X-GitHub-Delivery': `test-${Date.now()}`,
        'X-Hub-Signature-256': 'sha256=fake_signature_for_testing',
        'X-Webhook-Source': 'pr-autopilot-queue'
      },
      body: payloadString
    });

    const responseText = await response.text();
    console.log(`Response: ${response.status} - ${responseText}`);
    return response.ok;
  } catch (error) {
    console.error(`Error: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('Testing PR Autopilot Agent');
  console.log('==========================');
  
  // Test each webhook type
  await sendWebhook('pull_request_review_comment', testPayloads.reviewComment);
  await new Promise(r => setTimeout(r, 500));
  
  await sendWebhook('pull_request_review', testPayloads.reviewSubmitted);
  await new Promise(r => setTimeout(r, 500));
  
  await sendWebhook('pull_request', testPayloads.prOpened);
  
  console.log('\n=== Tests Complete ===');
  console.log('Check the agent logs for [WEBHOOK], [HANDLER], [PARSER], [FILTER], [COMMENT_EVENT], and [JOB] messages');
  console.log('If you see these messages, the logging is working and you can trace the flow.');
}

main().catch(console.error);
