# n8n Integration for PR Autopilot

This document explains how to integrate the PR Autopilot project with n8n for automated GitHub PR review handling.

## Overview

The PR Autopilot n8n integration allows you to:
- Monitor and manage the PR Autopilot agent from n8n
- Receive GitHub webhooks through n8n and forward them to the agent
- Trigger manual PR processing from n8n workflows
- Set up health monitoring and automatic restarts

## Prerequisites

Before setting up the integration, ensure you have:

1. n8n running (started via `npx n8n`)
2. PR Autopilot project installed at `/home/workspace/Skills/pr-autopilot`
3. Python virtual environment set up with required dependencies
4. GitHub App configured with appropriate permissions
5. Required environment variables set up in n8n

## Environment Variables

The integration requires several environment variables. In n8n, you can provide these in multiple ways:

### Method 1: n8n Credentials System
Use n8n's credential system to store sensitive information like tokens.

### Method 2: Global Environment Variables
Set environment variables in your system and ensure n8n inherits them.

### Method 3: Using n8n Expression Syntax
Reference environment variables in commands using `{{ $env.VARIABLE_NAME }}`.

For Execute Command nodes, use one of these approaches:

1. **Direct reference**: `GITHUB_TOKEN="{{ $env.GITHUB_TOKEN }}" command...`
2. **Export first**: `export GITHUB_TOKEN="{{ $env.GITHUB_TOKEN }}" && command...`
3. **Environment file**: Create `.env` file and source it in commands

See `EXECUTE_COMMAND_CONFIG.md` for detailed examples of each approach.

## Setup Steps

### 1. Environment Variables in n8n

Set up the following environment variables in your n8n instance:

- `GITHUB_TOKEN`: GitHub personal access token with appropriate permissions
- `WEBHOOK_SECRET`: Secret used to verify GitHub webhooks
- `ZO_CLIENT_IDENTITY_TOKEN`: Token for LLM patch generation (if applicable)
- `AGENT_PORT`: Port for the PR Autopilot agent (default: 3000)

### 2. Import the Workflow

Import the workflow template from `pr-autopilot-workflow.json` into your n8n instance.

### 3. Configure the Webhook Endpoint

The workflow includes a webhook endpoint at `/pr-autopilot-webhook`. Configure your GitHub App to send webhooks to:
`https://your-n8n-instance.com/webhook/pr-autopilot-webhook`

### 4. Set Up Credentials

Configure the following credentials in n8n if using notification nodes:
- Slack API credential (for alerts)

## Workflow Components

### Schedule Trigger
- Runs on a schedule to monitor the PR Autopilot agent status
- Default: Every 15 minutes

### Execute Command Nodes
- Check the status of the PR Autopilot agent
- Start the agent if it's not running
- Commands use the bash script approach to activate the Python virtual environment

### Webhook Handler
- Receives GitHub webhooks through n8n
- Forwards them to the local PR Autopilot agent
- Maintains proper headers for webhook verification

### Conditional Logic
- Checks if the agent is healthy
- Sends notifications if restart is needed
- Implements retry logic for failed operations

## Available Commands

The integration includes several Execute Command configurations:

1. **Start PR Autopilot Agent**: Starts the agent service
2. **Check PR Autopilot Status**: Verifies if the agent is running
3. **Reprocess a Specific PR**: Manually triggers processing for a specific PR
4. **Health Check**: Performs a health check on the running agent
5. **Stop and Restart Agent**: Stops and restarts the agent if needed

## Webhook Handling

The integration provides two webhook handler implementations:

1. **Bash Script Version** (`n8n-webhook-handler.sh`): Shell script that forwards webhooks
2. **Node.js Version** (`n8n-webhook-handler.js`): JavaScript implementation with more robust error handling

Both implementations:
- Extract webhook data from n8n's input format
- Preserve GitHub-specific headers
- Forward the webhook to the local PR Autopilot agent
- Return appropriate responses to GitHub

## Monitoring and Maintenance

The workflow includes monitoring capabilities:
- Regular health checks of the PR Autopilot agent
- Automatic restart if the agent becomes unresponsive
- Notification systems for failures
- Logging for troubleshooting

## Troubleshooting

### Common Issues

1. **Permission Errors**: Ensure n8n runs as the same user that owns the project files
2. **Virtual Environment Not Found**: Verify the path to your Python virtual environment
3. **Webhook Verification Failures**: Check that the webhook secret matches between GitHub and your configuration
4. **Agent Not Starting**: Verify that all required environment variables are set

### Debugging Commands

Use the Execute Command nodes to run diagnostic commands:
- Check if the agent process is running
- View recent logs
- Test connectivity to GitHub API

## Security Considerations

- Store sensitive tokens securely in n8n's credential system
- Use webhook secrets to verify GitHub requests
- Limit the permissions of the GitHub token to only necessary scopes
- Regularly rotate tokens

## Scaling Considerations

- For high-volume environments, consider running the PR Autopilot agent as a separate service
- Use n8n's scaling features to handle increased load
- Implement rate limiting to prevent overwhelming GitHub's API
- Consider using a queue system for processing PRs

## Updating the Integration

When updating the PR Autopilot project:

1. Update the project files in `/home/workspace/Skills/pr-autopilot`
2. Update the workflow if new features require changes
3. Test the integration in a non-production environment first
4. Update any command paths if the project structure changes

## Testing the Webhook

To test the webhook functionality:

1. Make sure your n8n workflow is activated and the webhook endpoint is running
2. Update the webhook URL in `send-test-webhook.sh` to match your n8n instance
3. Run the test script:
   ```bash
   ./send-test-webhook.sh
   ```

The test script sends a simulated GitHub pull request review comment webhook to your n8n endpoint, which should then forward it to the PR Autopilot agent.

## `Queue Webhook` Troubleshooting

- **Root cause**: `JSON.stringify($json)` breaks whenever the incoming webhook body is already binary or compressed (GitHub can gzip large deliveries, and n8n may hand you the raw buffer). That produces a base64 string that decodes to garbage (`0x06` prefix) and makes `queue-webhook.js` fail with `Unexpected token`.
- **Diagnostic step**: Place a Code/Function node right before `Queue Webhook` with the following snippet to log the payload type and header hints:
  ```js
  const body = $json.body;
  console.log('Is body binary?', Buffer.isBuffer(body));
  console.log('Body prefix:', Buffer.isBuffer(body) ? body.slice(0, 16).toString('hex') : 'not buffer');
  console.log('Content-Type:', $json.headers?.['content-type'] ?? 'missing');
  console.log('Content-Encoding:', $json.headers?.['content-encoding'] ?? 'none');
  return $input.all();
  ```
- **Fix**: Pass just `{ body, headers }` through the Execute Command so `queue-webhook.js` can handle decompression itself. Replace the command with:
  ```bash
  cd /home/workspace/Skills/pr-autopilot/n8n-integration && \
  node queue-webhook.js "{{ Buffer.from(JSON.stringify({ body: $json.body, headers: $json.headers })).toString('base64') }}"
  ```
  This mirrors the shape the script expects (it already checks for gzip/brotli/deflate signatures on the decoded buffer).

After applying these steps and rerunning the webhook, look for the `first bytes hex` log output and confirm `queue-webhook.js` no longer errors. If GitHub still sends compressed data, n8n will log `content-encoding: gzip` and the script’s decompression helpers will decode it correctly.

## Security Considerations

The integration is designed with security in mind:

1. **Webhook Authentication**: GitHub webhooks are authenticated using the webhook secret that's validated by the PR Autopilot agent
2. **Environment Variables**: Sensitive data like tokens should be stored in n8n's credential system
3. **Network Isolation**: The webhook forwarding happens locally (localhost), reducing exposure
4. **Input Validation**: The PR Autopilot agent validates all inputs before processing
5. **Rate Limiting**: The agent includes built-in rate limiting to prevent abuse

## Webhook Queuing and Concurrency

The integration includes a sophisticated queuing mechanism to handle multiple concurrent webhooks:

1. **Immediate Acknowledgment**: When a webhook arrives, it's immediately acknowledged and queued for processing
2. **Asynchronous Processing**: A separate scheduled workflow processes queued webhooks every 5 seconds
3. **Retry Logic**: Failed webhook deliveries are retried up to 3 times before being moved to an error directory
4. **Agent Status Awareness**: The processor checks if the agent is running before attempting to forward webhooks
5. **Temporary Storage**: Queued webhooks are stored in `/tmp/pr-autopilot-queue/` with metadata for tracking

This queuing system ensures that:
- GitHub receives immediate acknowledgment of webhook receipt
- Multiple concurrent webhooks are processed in order
- Failed deliveries are retried automatically
- The system gracefully handles periods when the agent is not running