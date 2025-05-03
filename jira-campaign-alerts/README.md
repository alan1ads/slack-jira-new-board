# Jira Campaign Alerts

A Slack application that monitors Jira issues and sends alerts to Slack when campaign status timers exceed thresholds.

## Features

- Monitors Jira issues from a specified project
- Tracks how long issues remain in each campaign status
- Sends notifications to Slack when issues exceed configured time thresholds
- Daily reminders for issues in PHASE statuses
- Automatically pauses notifications on weekends
- Includes Slack slash commands for configuration and monitoring

## Environment Variables

Create a `.env` file in the project root with the following variables:

```
# Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_ALERTS_CHANNEL=C0123456789

# Jira Configuration
JIRA_HOST=your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT=YOUR_PROJECT_KEY

# Render Configuration (if deploying to render.com)
RENDER=true
```

## Available Slack Commands

- `/check-duration [ISSUE-KEY]` - Check how long an issue has been in its current status
- `/update-threshold [STATUS] [MINUTES]` - Update the threshold for a specific status
- `/list-thresholds` - List all configured thresholds
- `/reload-tracking` - Force reload of tracking data from Jira

## Installation

1. Clone the repository
2. Install dependencies with `npm install`
3. Create a `.env` file with your configuration
4. Start the application with `npm start`

## Development

For local development, use `npm run dev` to start the application with nodemon for automatic restarts.

## Deployment to Render.com

This application is designed to be easily deployed to Render.com:

1. Create a new Web Service in Render.com
2. Link to your GitHub repository
3. Set the build command to `npm install`
4. Set the start command to `npm start`
5. Add all environment variables from the `.env` file to Render's environment variables
6. Enable the "Auto-Deploy" feature

The application includes health check endpoints at `/` and `/health` which Render uses to verify the service is running.

## Default Campaign Status Thresholds

| Status | Threshold (minutes) | Threshold (hours) |
|--------|---------------------|-------------------|
| NEW REQUEST | 10 | 0.17 |
| REQUEST REVIEW | 1200 | 20 |
| READY TO SHIP | 1440 | 24 |
| SUBMISSION REVIEW | 240 | 4 |
| PHASE 1 | 1440 | 24 |
| PHASE 2 | 1440 | 24 |
| PHASE 3 | 1440 | 24 |
| PHASE 4 | 1440 | 24 |
| PHASE 5 | 1440 | 24 |

**Note:** PHASE COMPLETE, FAILED, and NEED MORE AMMO statuses do not trigger alerts. 