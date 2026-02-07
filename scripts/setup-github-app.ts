import * as fs from 'fs';
import * as path from 'path';

const permissionsPath = path.join(__dirname, '..', 'assets', 'permissions.json');
const permissions = JSON.parse(fs.readFileSync(permissionsPath, 'utf-8'));

console.log('PR Autopilot GitHub App Setup');
console.log('-------------------------------');
console.log('1. Visit https://github.com/settings/apps and click "New GitHub App".');
console.log('2. Fill in:');
console.log('   • App name: PR Autopilot');
console.log('   • Homepage URL: https://your-domain.com');
console.log('   • Webhook URL: https://your-domain.com/webhook');
console.log('   • Webhook secret: choose a strong random value and store it in WEBHOOK_SECRET.');
console.log('3. Under "Permissions", apply the following configuration:');
console.log(JSON.stringify(permissions, null, 2));
console.log('4. Check the events: pull_request, pull_request_review, pull_request_review_comment, issue_comment, check_suite, check_run.');
console.log('5. Save the app, install it into the repositories you want to automate, and note the App ID.');
console.log('6. Download the private key. Set the following environment variables when you run the agent:');
console.log('   • GITHUB_APP_ID');
console.log('   • GITHUB_PRIVATE_KEY (PEM content)');
console.log('   • GITHUB_TOKEN (installation token or PAT with repo write scope)');
console.log('   • WEBHOOK_SECRET (match the secret you configured)');
console.log('7. Start the agent with `bun run scripts/agent.ts`.');
