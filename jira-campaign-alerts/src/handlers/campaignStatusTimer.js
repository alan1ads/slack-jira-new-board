const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Add timer alerts channel constant - this will be set via environment variable
const TIMER_ALERTS_CHANNEL = process.env.SLACK_ALERTS_CHANNEL;

// Define the path for the tracking data file
const TRACKING_FILE_PATH = process.env.RENDER ? 
  '/opt/render/project/src/data/tracking.json' : 
  path.join(__dirname, '../../data/tracking.json');

// Ensure the data directory exists
const dataDir = process.env.RENDER ? 
  '/opt/render/project/src/data' : 
  path.join(__dirname, '../../data');

// Add lock file path
const LOCK_FILE_PATH = path.join(dataDir, '.lock');

// Helper function to check if current time is weekend in ET timezone
const isWeekendET = () => {
  // Create date in ET timezone
  const options = { timeZone: 'America/New_York' };
  const now = new Date();
  const etDate = new Date(now.toLocaleString('en-US', options));
  
  // Get day of week (0 = Sunday, 6 = Saturday)
  const day = etDate.getDay();
  
  // Weekend is Saturday (6) and Sunday (0)
  return day === 0 || day === 6;
};

// Helper function to check if a specific date is weekend in ET timezone
const isDateWeekendET = (date) => {
  // Create date in ET timezone
  const options = { timeZone: 'America/New_York' };
  const etDate = new Date(date.toLocaleString('en-US', options));
  
  // Get day of week (0 = Sunday, 6 = Saturday)
  const day = etDate.getDay();
  
  // Weekend is Saturday (6) and Sunday (0)
  return day === 0 || day === 6;
};

// Calculate business time between two dates, excluding weekends
const calculateBusinessTimeBetween = (startDate, endDate) => {
  // Clone dates to avoid modifying the originals
  const start = new Date(startDate.getTime());
  const end = new Date(endDate.getTime());
  
  // Initialize the total time
  let totalMs = 0;
  
  // Process each day, adding only business days
  const currentDay = new Date(start.getTime());
  
  while (currentDay < end) {
    // Move to next day
    const nextDay = new Date(currentDay.getTime() + 24 * 60 * 60 * 1000);
    
    // If it's not a weekend, add the time
    if (!isDateWeekendET(currentDay)) {
      // Calculate the time to add for this day
      const timeToAdd = Math.min(nextDay.getTime(), end.getTime()) - currentDay.getTime();
      totalMs += timeToAdd;
    }
    
    // Move to the next day
    currentDay.setTime(nextDay.getTime());
  }
  
  return totalMs;
};

// Function to check if we should send Slack notifications
const shouldSendSlackNotifications = () => {
  if (isWeekendET()) {
    console.log('🔕 Weekend detected in ET timezone. Slack notifications are paused.');
    return false;
  }
  return true;
};

// Load tracking data from file or initialize if doesn't exist
let activeTracking = {
  campaign: {}     // For status field (Campaign Status)
};

// Function to acquire lock
const acquireLock = () => {
  try {
    fs.writeFileSync(LOCK_FILE_PATH, String(process.pid));
    return true;
  } catch (error) {
    console.error('Failed to acquire lock:', error);
    return false;
  }
};

// Function to release lock
const releaseLock = () => {
  try {
    if (fs.existsSync(LOCK_FILE_PATH)) {
      fs.unlinkSync(LOCK_FILE_PATH);
    }
  } catch (error) {
    console.error('Failed to release lock:', error);
  }
};

// Function to load tracking data from Jira
const loadTrackingDataFromJira = async (app) => {
  console.log('🔄 Initializing tracking data from Jira...');
  
  try {
    // First try to load local data as a backup/starting point
    loadTrackingDataFromFile();
    
    // Get all active issues from Jira
    console.log('🔍 Fetching active issues from Jira...');
    
    // Construct JQL query more carefully
    let jqlQuery;
    try {
      // Try a simpler query first to test connectivity
      const testResponse = await axios({
        method: 'GET',
        url: `https://${process.env.JIRA_HOST}/rest/api/3/myself`,
        auth: {
          username: process.env.JIRA_EMAIL,
          password: process.env.JIRA_API_TOKEN
        }
      });
      
      console.log('✅ Jira connection test successful, user:', testResponse.data.displayName);
      
      // Use a simpler JQL query with proper escaping
      jqlQuery = `project = "${process.env.JIRA_PROJECT}"`;
      console.log('🔍 Using JQL query:', jqlQuery);
      
    } catch (testError) {
      console.error('❌ Jira connection test failed:', testError.message);
      if (testError.response) {
        console.error('  Status:', testError.response.status);
        console.error('  Data:', JSON.stringify(testError.response.data));
      }
      throw new Error('Could not connect to Jira API: ' + testError.message);
    }
    
    const response = await axios({
      method: 'GET',
      url: `https://${process.env.JIRA_HOST}/rest/api/3/search`,
      auth: {
        username: process.env.JIRA_EMAIL,
        password: process.env.JIRA_API_TOKEN
      },
      params: {
        jql: jqlQuery,
        maxResults: 100,
        fields: 'key,status,summary,created,updated,assignee'
      }
    });
    
    if (!response.data || !response.data.issues) {
      console.log('⚠️ No active issues found in Jira or could not retrieve data');
      return;
    }
    
    console.log(`🔍 Found ${response.data.issues.length} active issues to track`);
    
    // Get all issues to process
    const activeIssues = response.data.issues;
    
    // Track issues we've processed to detect any that need to be removed
    const processedIssues = new Set();
    
    // Process each issue and set up tracking
    for (const issue of activeIssues) {
      const issueKey = issue.key;
      const campaignStatus = issue.fields.status.name;  // Campaign Status field
      const assignee = issue.fields.assignee;
      
      console.log(`📋 Processing issue ${issueKey} - Campaign: ${campaignStatus}`);
      
      try {
        // Get issue history to determine how long it's been in current status
        const historyResponse = await axios({
          method: 'GET',
          url: `https://${process.env.JIRA_HOST}/rest/api/3/issue/${issueKey}/changelog`,
          auth: {
            username: process.env.JIRA_EMAIL,
            password: process.env.JIRA_API_TOKEN
          }
        });
        
        // Find the most recent status change
        let campaignStatusChangeTime = new Date(issue.fields.created);
        
        // Get last alert time from existing tracking (if any)
        let campaignLastAlertTime = activeTracking.campaign[issueKey]?.lastAlertTime || null;
        
        if (historyResponse.data && historyResponse.data.values) {
          // Process changelog for status changes
          for (const history of historyResponse.data.values) {
            const created = new Date(history.created);
            
            for (const item of history.items) {
              // Check for Campaign Status changes
              if (item.field === 'status' && item.toString === campaignStatus) {
                if (created > campaignStatusChangeTime) {
                  campaignStatusChangeTime = created;
                }
              }
            }
          }
        }
        
        // Track the Campaign Status
        const campaignThresholdMs = getThresholdMs('campaign', campaignStatus, issue);
        
        const shouldTrackCampaign = campaignThresholdMs !== null;
        
        if (shouldTrackCampaign) {
          // Add to processed set
          processedIssues.add(issueKey);
          
          activeTracking.campaign[issueKey] = {
            status: campaignStatus,
            startTime: campaignStatusChangeTime,
            lastAlertTime: campaignLastAlertTime,
            issue: {
              key: issue.key,
              fields: {
                summary: issue.fields.summary,
                assignee: issue.fields.assignee
              }
            }
          };
          console.log(`⏱️ Tracking Campaign Status for ${issueKey}: ${campaignStatus} (since ${campaignStatusChangeTime.toISOString()})`);
        } else {
          console.log(`⏭️ Skipping tracking for ${issueKey}: ${campaignStatus} (timer disabled for this status)`);
        }
        
      } catch (historyError) {
        console.error(`❌ Error retrieving history for ${issueKey}:`, historyError.message);
        
        // Use existing tracking data if available, otherwise use created time
        const campaignThresholdMs = getThresholdMs('campaign', campaignStatus, issue);
        if (campaignStatus && campaignThresholdMs !== null) {
          processedIssues.add(issueKey);
          
          activeTracking.campaign[issueKey] = activeTracking.campaign[issueKey] || {
            status: campaignStatus,
            startTime: new Date(issue.fields.created),
            lastAlertTime: null,
            issue: {
              key: issue.key,
              fields: {
                summary: issue.fields.summary,
                assignee: issue.fields.assignee
              }
            }
          };
        }
      }
    }
    
    // Remove any issues that are no longer active
    for (const issueKey of Object.keys(activeTracking.campaign)) {
      if (!processedIssues.has(issueKey)) {
        console.log(`🧹 Removing stale campaign tracking for ${issueKey}`);
        delete activeTracking.campaign[issueKey];
      }
    }
    
    // Save the tracking data to file
    saveTrackingData();
    
    console.log('✅ Jira tracking data initialized successfully:', {
      campaignCount: Object.keys(activeTracking.campaign).length,
      campaigns: Object.keys(activeTracking.campaign)
    });
    
  } catch (error) {
    console.error('❌ Error initializing tracking data from Jira:', error.message);
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  Error details:', JSON.stringify(error.response.data || {}));
    }
    // If Jira sync fails, fall back to local file
    console.log('⚠️ Falling back to local tracking data');
    loadTrackingDataFromFile();
  }
};

// Function to load tracking data from file
const loadTrackingDataFromFile = () => {
  try {
    console.log('📂 Loading tracking data from file...');
    console.log('📂 Data directory path:', dataDir);
    console.log('📂 Tracking file path:', TRACKING_FILE_PATH);
    
    // Create data directory if it doesn't exist
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log('📁 Created data directory at:', dataDir);
      } catch (dirError) {
        console.error('❌ Error creating data directory:', dirError);
      }
    }

    // Try to acquire lock
    if (!acquireLock()) {
      console.log('⚠️ Could not acquire lock, using cached data');
      return;
    }

    try {
      // Load existing data if file exists
      if (fs.existsSync(TRACKING_FILE_PATH)) {
        console.log('📄 Found tracking file at:', TRACKING_FILE_PATH);
        const fileStats = fs.statSync(TRACKING_FILE_PATH);
        console.log('📄 File stats:', {
          size: fileStats.size,
          modified: fileStats.mtime
        });

        const data = fs.readFileSync(TRACKING_FILE_PATH, 'utf8');
        
        if (!data.trim()) {
          console.log('⚠️ Tracking file is empty, initializing new data');
          return;
        }

        try {
          const parsed = JSON.parse(data);
          
          if (!parsed || typeof parsed !== 'object') {
            console.log('⚠️ Invalid tracking data format, initializing new data');
            return;
          }

          // Process campaign data
          if (parsed.campaign && typeof parsed.campaign === 'object') {
            Object.entries(parsed.campaign).forEach(([key, item]) => {
              if (item && typeof item === 'object') {
                activeTracking.campaign[key] = {
                  ...item,
                  startTime: new Date(item.startTime),
                  lastAlertTime: item.lastAlertTime ? new Date(item.lastAlertTime) : null
                };
              }
            });
          }

          console.log('📥 Loaded tracking data from file successfully:', {
            campaignCount: Object.keys(activeTracking.campaign).length
          });
        } catch (parseError) {
          console.error('❌ Error parsing tracking data:', parseError);
        }
      } else {
        console.log('📝 No existing tracking file found');
      }
    } finally {
      releaseLock();
    }
  } catch (error) {
    console.error('❌ Error in loadTrackingDataFromFile:', error);
    releaseLock();
  }
};

// Function to save tracking data to file
const saveTrackingData = () => {
  try {
    console.log('💾 Attempting to save tracking data:', {
      currentCampaigns: Object.keys(activeTracking.campaign),
      path: TRACKING_FILE_PATH
    });

    // Try to acquire lock
    if (!acquireLock()) {
      console.log('⚠️ Could not acquire lock for saving, will retry on next update');
      return;
    }

    try {
      // Ensure the directory exists
      if (!fs.existsSync(dataDir)) {
        try {
          fs.mkdirSync(dataDir, { recursive: true });
          console.log('📁 Created data directory for saving at:', dataDir);
        } catch (dirError) {
          console.error('❌ Error creating data directory:', dirError);
          // Continue anyway - we'll try to save the file
        }
      }

      // Prepare data for saving
      const dataToSave = {
        campaign: {}
      };

      // Process campaign data
      Object.entries(activeTracking.campaign).forEach(([key, item]) => {
        if (item && typeof item === 'object') {
          dataToSave.campaign[key] = {
            ...item,
            startTime: item.startTime.toISOString(),
            lastAlertTime: item.lastAlertTime ? item.lastAlertTime.toISOString() : null
          };
        }
      });

      try {
        // Write to temporary file first
        const tempPath = `${TRACKING_FILE_PATH}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(dataToSave, null, 2), { encoding: 'utf8', flag: 'w' });

        // Verify the temporary file was written correctly
        const tempData = fs.readFileSync(tempPath, 'utf8');
        const tempParsed = JSON.parse(tempData);
        
        if (!tempParsed || typeof tempParsed !== 'object') {
          throw new Error('Failed to write valid data to temporary file');
        }

        // Rename temporary file to actual file (atomic operation)
        fs.renameSync(tempPath, TRACKING_FILE_PATH);

        // Verify the file exists after saving
        if (!fs.existsSync(TRACKING_FILE_PATH)) {
          throw new Error('File does not exist after save operation');
        }

        console.log('💾 Saved tracking data successfully:', {
          campaignCount: Object.keys(dataToSave.campaign).length,
          path: TRACKING_FILE_PATH
        });
      } catch (writeError) {
        console.error('❌ Error writing tracking file:', writeError);
        // If normal save fails, try saving to /tmp as a fallback
        try {
          const tmpPath = '/tmp/tracking.json';
          fs.writeFileSync(tmpPath, JSON.stringify(dataToSave, null, 2), 'utf8');
          console.log('💾 Saved tracking data to temporary location:', tmpPath);
        } catch (tmpError) {
          console.error('❌ Failed to save tracking data to temporary location:', tmpError);
        }
      }
    } finally {
      releaseLock();
    }
  } catch (error) {
    console.error('❌ Error saving tracking data:', error);
    releaseLock();
  }
};

// Campaign Status thresholds (in minutes)
const CAMPAIGN_STATUS_THRESHOLDS = {
  // New statuses with their corresponding thresholds
  "1: Lander URL delivery": null,           // Timer disabled
  "2: Creative Delivery (video, i": null,   // Timer disabled
  "3: Angle (copy y headline) cre": null,   // Timer disabled 
  "4: Campaign creation": 1440,             // 24 hours
  "5: Submission Review": 1440,             // 24 hours
  "6: Live - FASE1-5": 12960,               // 9 days (216 hours)
  "7: mediabuyer handout": null             // Timer disabled
};

// Check if issue has an assignee
const hasAssignee = (issue) => {
  return issue?.fields?.assignee !== null;
};

// Convert minutes to milliseconds with special handling
const getThresholdMs = (statusType, statusValue, issue) => {
  // For campaign status, convert to uppercase to match keys
  const campaignStatus = statusValue.toUpperCase();
  
  // Return null for statuses with disabled timers
  if (
    campaignStatus.includes("1: LANDER URL DELIVERY") || 
    campaignStatus.includes("2: CREATIVE DELIVERY") || 
    campaignStatus.includes("3: ANGLE") || 
    campaignStatus.includes("7: MEDIABUYER HANDOUT")
  ) {
    return null;
  }
  
  return (CAMPAIGN_STATUS_THRESHOLDS[statusValue] || 5) * 60 * 1000;
};

// Function to fetch the latest comment for an issue
const getLatestComment = async (issueKey) => {
  try {
    console.log(`📝 Fetching comments for issue ${issueKey}`);
    const response = await axios({
      method: 'GET',
      url: `https://${process.env.JIRA_HOST}/rest/api/3/issue/${issueKey}/comment?maxResults=1&orderBy=-created`,
      auth: {
        username: process.env.JIRA_EMAIL,
        password: process.env.JIRA_API_TOKEN
      }
    });
    
    if (response.data && response.data.comments && response.data.comments.length > 0) {
      const comment = response.data.comments[0];
      console.log(`📝 Found latest comment from ${comment.author.displayName}`);
      
      // Extract the text content from the Jira comment body
      let commentText = '';
      if (comment.body && comment.body.type === 'doc') {
        // Try to extract text from Jira's Atlassian Document Format
        try {
          commentText = comment.body.content
            .map(block => {
              if (block.type === 'paragraph') {
                return block.content
                  .filter(item => item.type === 'text')
                  .map(item => item.text)
                  .join('');
              }
              return '';
            })
            .join('\n')
            .trim();
        } catch (e) {
          commentText = 'Error parsing comment content';
        }
      } else if (typeof comment.body === 'string') {
        commentText = comment.body;
      }
      
      return {
        text: commentText,
        author: comment.author.displayName,
        created: comment.created
      };
    }
    
    console.log(`📝 No comments found for issue ${issueKey}`);
    return null;
  } catch (error) {
    console.error(`❌ Error fetching comments for ${issueKey}:`, error.message);
    return null;
  }
};

// Add ensure channel access function
const ensureChannelAccess = async (app, channelId) => {
  try {
    await app.client.conversations.join({
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId
    });
  } catch (error) {
    console.error('Error joining channel:', error);
  }
};

// Add a function to check if issue exists
const checkIssueExists = async (issueKey) => {
  try {
    await axios({
      method: 'GET',
      url: `https://${process.env.JIRA_HOST}/rest/api/3/issue/${issueKey}`,
      auth: {
        username: process.env.JIRA_EMAIL,
        password: process.env.JIRA_API_TOKEN
      }
    });
    return true;
  } catch (error) {
    if (error.response?.status === 404) {
      console.log(`🗑️ Issue ${issueKey} no longer exists, clearing tracking`);
      clearTracking(issueKey);
    }
    return false;
  }
};

// Function to check campaign status alerts
const checkCampaignAlerts = async (app) => {
  try {
    const now = new Date();
    let dataChanged = false;
    
    // Check if we're in weekend mode
    const slackNotificationsEnabled = shouldSendSlackNotifications();
    if (!slackNotificationsEnabled) {
      console.log('🔕 Weekend mode active: Tracking pauses on weekends and Slack notifications are paused');
    }
    
    console.log('🔍 Checking tracked campaign statuses:', {
      campaign: Object.keys(activeTracking.campaign)
    });
    
    // Check Campaign Status
    for (const [issueKey, tracking] of Object.entries(activeTracking.campaign)) {
      // First verify issue still exists
      if (!(await checkIssueExists(issueKey))) {
        continue; // Skip if issue doesn't exist
      }

      // Calculate business time excluding weekends
      const businessTimeInStatus = calculateBusinessTimeBetween(tracking.startTime, now);
      
      // Store original time in status for logging purposes
      const totalTimeInStatus = now - tracking.startTime;
      
      // Log both times for comparison
      console.log(`🕒 Issue ${issueKey} time stats:`, {
        totalDays: (totalTimeInStatus / (24 * 60 * 60 * 1000)).toFixed(2),
        businessDays: (businessTimeInStatus / (24 * 60 * 60 * 1000)).toFixed(2),
        totalHours: (totalTimeInStatus / (60 * 60 * 1000)).toFixed(2),
        businessHours: (businessTimeInStatus / (60 * 60 * 1000)).toFixed(2)
      });
      
      const thresholdMs = getThresholdMs('campaign', tracking.status, tracking.issue);
      
      // Skip statuses with null thresholds
      if (thresholdMs === null) {
        continue;
      }
      
      // Use 24 hour reminder interval (1440 minutes) for ALL statuses after initial alert
      const reminderIntervalMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
      
      // Use businessTimeInStatus instead of totalTimeInStatus for threshold check
      // Also calculate business time since last alert
      const businessTimeSinceLastAlert = tracking.lastAlertTime 
        ? calculateBusinessTimeBetween(tracking.lastAlertTime, now) 
        : thresholdMs;
        
      const shouldAlert = businessTimeInStatus > thresholdMs && 
                        (tracking.lastAlertTime === null || businessTimeSinceLastAlert >= reminderIntervalMs);

      // Always fetch the latest comment for the issue, even if we don't send an alert
      const latestComment = await getLatestComment(issueKey);
      
      // Store the latest comment in the tracking data for future reference
      if (latestComment) {
        activeTracking.campaign[issueKey].latestComment = latestComment;
        dataChanged = true;
      }

      if (shouldAlert) {
        console.log(`⚠️ Campaign Status threshold exceeded for ${issueKey}: ${Math.round(businessTimeInStatus / 60000)}m in ${tracking.status} (business time only)`);
        
        // Update lastAlertTime regardless of whether we send to Slack
        activeTracking.campaign[issueKey].lastAlertTime = now;
        dataChanged = true;
        
        // Calculate days in status for alert message
        const businessDaysInStatus = (businessTimeInStatus / (24 * 60 * 60 * 1000)).toFixed(1);
        const isFirstAlert = tracking.lastAlertTime === null || tracking.lastAlertTime === now;
        
        // Only send to Slack if not weekend
        if (slackNotificationsEnabled) {
          // Ensure channel access before sending
          await ensureChannelAccess(app, TIMER_ALERTS_CHANNEL);
          
          // Prepare message blocks
          const messageBlocks = [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: isFirstAlert ? "⏰ Campaign Status Timer Alert" : "🔄 Campaign Status Reminder",
                emoji: true
              }
            },
            {
              type: "section",
              fields: [
                {
                  type: "mrkdwn",
                  text: `*Issue:*\n<https://${process.env.JIRA_HOST}/browse/${issueKey}|${issueKey}>`
                },
                {
                  type: "mrkdwn",
                  text: `*Campaign:*\n${tracking.status}`
                },
                {
                  type: "mrkdwn",
                  text: isFirstAlert
                    ? `*Alert:*\nExceeded time threshold of ${Math.round(thresholdMs / (60 * 60 * 1000))} hours`
                    : `*Reminder:*\nDaily reminder - issue has been in ${tracking.status} for ${businessDaysInStatus} business days`
                },
                {
                  type: "mrkdwn",
                  text: `*Business Time in Status:*\n${Math.round(businessTimeInStatus / 60000)} minutes (excludes weekends)`
                }
              ]
            }
          ];

          // Add latest comment section if available
          if (latestComment) {
            messageBlocks.push({
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Latest Comment:*\n>${latestComment.text}\n_by ${latestComment.author} at ${new Date(latestComment.created).toLocaleString()}_`
              }
            });
          }
          
          await app.client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: TIMER_ALERTS_CHANNEL,
            text: `Campaign Status ${isFirstAlert ? 'Alert' : 'Reminder'} for ${issueKey}`,
            blocks: messageBlocks
          });
          console.log(`✅ Sent campaign ${isFirstAlert ? 'alert' : 'reminder'} to Slack for ${issueKey}`);
        } else {
          console.log(`🔕 Weekend mode: Skipped sending campaign alert to Slack for ${issueKey}`);
        }
      }
    }

    // If any data changed, save it
    if (dataChanged) {
      saveTrackingData();
    }
  } catch (error) {
    console.error('Error checking campaign alerts:', error);
  }
};

// Clear tracking for an issue
const clearTracking = (issueKey) => {
  if (issueKey && activeTracking.campaign[issueKey]) {
    delete activeTracking.campaign[issueKey];
    console.log(`🧹 Cleared campaign tracking for ${issueKey}`);
    // Save tracking data after clearing
    saveTrackingData();
  }
};

// Function to update campaign threshold
const updateCampaignThreshold = (status, minutes) => {
  if (CAMPAIGN_STATUS_THRESHOLDS.hasOwnProperty(status)) {
    CAMPAIGN_STATUS_THRESHOLDS[status] = minutes;
    console.log(`Updated threshold for "${status}" to ${minutes} minutes`);
  } else {
    console.log(`Warning: "${status}" is not a valid Campaign Status`);
  }
};

// Function to check status duration for debugging
const checkStatusDuration = async ({ command, ack, say }) => {
  await ack();
  
  try {
    const issueKey = command.text.trim();
    
    if (!issueKey) {
      await say("Please provide an issue key: `/check-duration AS-123`");
      return;
    }
    
    // Get campaign data
    const campaignData = activeTracking.campaign[issueKey];
    
    const now = new Date();
    let blocks = [];
    
    if (!campaignData) {
      await say(`No tracking data found for issue ${issueKey}`);
      return;
    }
    
    // Display campaign data - calculate both total time and business time
    const totalTimeInStatus = now - campaignData.startTime;
    const businessTimeInStatus = calculateBusinessTimeBetween(campaignData.startTime, now);
    
    const totalMinutesInStatus = Math.round(totalTimeInStatus / 60000);
    const businessMinutesInStatus = Math.round(businessTimeInStatus / 60000);
    
    const totalHoursInStatus = (totalMinutesInStatus / 60).toFixed(1);
    const businessHoursInStatus = (businessMinutesInStatus / 60).toFixed(1);
    
    blocks.push({
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Campaign Status:*\n${campaignData.status}`
        },
        {
          type: "mrkdwn",
          text: `*Started At:*\n${campaignData.startTime.toLocaleString()}`
        },
        {
          type: "mrkdwn",
          text: `*Total Time in Status:*\n${totalMinutesInStatus} minutes (${totalHoursInStatus} hours)`
        },
        {
          type: "mrkdwn",
          text: `*Business Time in Status:*\n${businessMinutesInStatus} minutes (${businessHoursInStatus} hours)\n_Excludes weekends_`
        }
      ]
    });
    
    blocks.push({
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Last Alert:*\n${campaignData.lastAlertTime ? campaignData.lastAlertTime.toLocaleString() : 'No alerts sent'}`
        },
        {
          type: "mrkdwn",
          text: isDateWeekendET(now) ? "*Currently:*\n🔕 Weekend - timer paused" : "*Currently:*\n⏱️ Weekday - timer active"
        }
      ]
    });
    
    await say({
      text: `Status duration info for ${issueKey}`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: `⏱️ Status Duration for ${issueKey}`,
            emoji: true
          }
        },
        ...blocks
      ]
    });
    
  } catch (error) {
    console.error('Error checking status duration:', error);
    await say(`Error checking status duration: ${error.message}`);
  }
};

// Export the functions
module.exports = {
  loadTrackingDataFromJira,
  checkCampaignAlerts,
  checkStatusDuration,
  updateCampaignThreshold,
  clearTracking,
  CAMPAIGN_STATUS_THRESHOLDS
}; 