const { App, ExpressReceiver } = require('@slack/bolt');
const express = require('express');
const { 
  loadTrackingDataFromJira, 
  checkCampaignAlerts, 
  checkStatusDuration,
  updateCampaignThreshold,
  CAMPAIGN_STATUS_THRESHOLDS
} = require('./src/handlers/campaignStatusTimer');
require('dotenv').config();

// Check for required environment variables
const requiredEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_APP_TOKEN',
  'SLACK_ALERTS_CHANNEL',
  'JIRA_HOST',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT'
];

const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
if (missingEnvVars.length > 0) {
  console.error('❌ Missing required environment variables:', missingEnvVars.join(', '));
  console.error('Please add them to your .env file');
  process.exit(1);
}

// Create a single receiver for both Slack and health checks
const port = process.env.PORT || 3000;
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  processBeforeResponse: true
});

// Add health check routes to the same Express instance
receiver.router.get('/', (req, res) => {
  res.send('Jira Campaign Alerts service is running');
});
receiver.router.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Initialize the Slack app with the receiver
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  // Disable socket mode on Render
  socketMode: !process.env.RENDER,
  appToken: !process.env.RENDER ? process.env.SLACK_APP_TOKEN : undefined,
  receiver: process.env.RENDER ? receiver : undefined
});

// Create a slash command to check issue duration
app.command('/check-duration', checkStatusDuration);

// Create a slash command to update thresholds
app.command('/update-threshold', async ({ command, ack, say }) => {
  await ack();
  
  try {
    const args = command.text.split(' ');
    if (args.length < 2) {
      await say("Usage: `/update-threshold STATUS_NAME MINUTES`\nExample: `/update-threshold \"4: Campaign creation\" 1440`");
      return;
    }
    
    // Extract status name and minutes
    const minutes = parseInt(args.pop());
    const status = args.join(' ');
    
    if (isNaN(minutes)) {
      await say(`Error: "${args.pop()}" is not a valid number of minutes`);
      return;
    }
    
    // Update the threshold
    updateCampaignThreshold(status, minutes);
    
    await say(`Updated threshold for "${status}" to ${minutes} minutes (${(minutes/60).toFixed(1)} hours)`);
  } catch (error) {
    console.error('Error updating threshold:', error);
    await say(`Error updating threshold: ${error.message}`);
  }
});

// Command to list all thresholds
app.command('/list-thresholds', async ({ ack, say }) => {
  await ack();
  
  try {
    const thresholds = Object.entries(CAMPAIGN_STATUS_THRESHOLDS)
      .filter(([_, minutes]) => minutes !== null)
      .map(([status, minutes]) => {
        const hours = (minutes / 60).toFixed(1);
        return `• *${status}*: ${minutes} minutes (${hours} hours)`;
      })
      .join('\n');
    
    await say({
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "⏱️ Campaign Status Thresholds",
            emoji: true
          }
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: thresholds
          }
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: "Use `/update-threshold STATUS_NAME MINUTES` to update a threshold"
            }
          ]
        }
      ]
    });
  } catch (error) {
    console.error('Error listing thresholds:', error);
    await say(`Error listing thresholds: ${error.message}`);
  }
});

// Command to force reload tracking data from Jira
app.command('/reload-tracking', async ({ ack, say }) => {
  await ack();
  
  try {
    await say("🔄 Reloading tracking data from Jira...");
    await loadTrackingDataFromJira(app);
    await say("✅ Tracking data reloaded from Jira");
  } catch (error) {
    console.error('Error reloading tracking data:', error);
    await say(`Error reloading tracking data: ${error.message}`);
  }
});

// Start the Slack app and schedule periodic tasks
(async () => {
  try {
    // Start the server
    await app.start(port);
    console.log(`⚡️ Jira Campaign Alerts app is running on port ${port}!`);
    
    // Initial load of tracking data from Jira
    await loadTrackingDataFromJira(app);
    
    // Set up periodic checks for status alerts (every 5 minutes)
    setInterval(async () => {
      await checkCampaignAlerts(app);
    }, 5 * 60 * 1000);
    
    // Set up periodic reload of tracking data from Jira (every 60 minutes)
    setInterval(async () => {
      await loadTrackingDataFromJira(app);
    }, 60 * 60 * 1000);
  } catch (error) {
    console.error('Error starting app:', error);
    process.exit(1);
  }
})(); 