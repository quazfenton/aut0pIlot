#!/bin/bash

# Script to send a test GitHub webhook to n8n
# This simulates a GitHub webhook for testing purposes

WEBHOOK_URL="https://n8n-veli.zocomputer.io/webhook/pr-autopilot"

# Sample GitHub webhook payload (pull_request_review_comment)
PAYLOAD='{
  "action": "created",
  "comment": {
    "id": 123456789,
    "body": "This is a test comment",
    "path": "test-file.js",
    "line": 10,
    "commit_id": "abc123def456",
    "user": {
      "login": "test-user"
    }
  },
  "repository": {
    "full_name": "test-org/test-repo"
  },
  "pull_request": {
    "number": 123
  }
}'

# Generate a fake signature (normally this would be computed with the webhook secret)
SIGNATURE="sha256=fake_signature_for_testing"

echo "Sending test webhook to: $WEBHOOK_URL"
echo "Payload:"
echo "$PAYLOAD" | jq '.'

# Send the webhook
curl -v -X POST \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request_review_comment" \
  -H "X-GitHub-Delivery: test-delivery-$(date +%s)" \
  -H "X-Hub-Signature-256: $SIGNATURE" \
  -d "$PAYLOAD" \
  "$WEBHOOK_URL"

echo ""
echo "Test webhook sent!"