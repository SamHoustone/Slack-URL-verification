// index.js — Slack DM Reminder Bot
// --------------------------------
// 1) package.json (root) must have:
// {
//   "type": "module",
//   "scripts": { "start": "node index.js" },
//   "dependencies": {
//     "@slack/web-api": "^7.3.0",
//     "chrono-node":  "^2.7.8",
//     "express":      "^4.19.0",
//     "morgan":       "^1.10.0"
//   }
// }
//
// 2) In Render (or your env), set:
//    SLACK_BOT_TOKEN = xoxb-…   (mark it Secret)
//
// 3) Slack App → OAuth & Permissions → Bot Token Scopes:
//    chat:write, im:read, im:write, users:read,
//    channels:read, channels:history
//    → Reinstall to Workspace
//
// 4) Event Subscriptions → Subscribe to Bot Events:
//    app_mention
//
// 5) Invite your bot to any channel you test in.

import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));

// Health-check endpoint
app.get("/slack/webhook", (_, res) =>
  res.send("Reminder bot is running. Use POST to /slack/webhook.")
);

// Main webhook
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  // 1) URL-verification handshake
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // 2) Only handle app_mention events
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }

  // 3) Always 200 OK
  res.sendStatus(200);
});

async function handleMention(event) {
  console.log("🔔 handleMention called", event.text);

  // Remove only the bot’s own mention
  const botId = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text = event.text.replace(botTag, "").trim();

  // Determine target and core message
  let targetUser, coreText;
  if (/^remind\s+me\s+/i.test(text)) {
    // "remind me ..."
    targetUser = event.user;
    coreText   = text.replace(/^remind\s+me\s+/i, "").trim();
  } else {
    // "remind @someone ..."
    const m = text.match(/<@([A-Z0-9]+)>/);
    if (!m) {
      console.log("⛔ no user mention");
      return;
    }
    targetUser = m[1];
    coreText   = text.replace(m[0], "").trim();
  }

  // Split off the time clause on the last " at "
  const lower = coreText.toLowerCase();
  const idx   = lower.lastIndexOf(" at ");
  if (idx === -1) {
    console.log("⛔ no 'at' keyword");
    return;
  }
  const message = coreText.slice(0, idx).trim();
  const whenRaw = coreText.slice(idx + 4).trim();
  if (!message || !whenRaw) {
    console.log("⛔ empty message or time");
    return;
  }

  // Parse natural time (ensuring "in 2 minutes" style)
  let whenText = whenRaw;
  if (/^\d+\s*(minutes?|hours?)$/i.test(whenRaw)) {
    whenText = "in " + whenRaw;
  }
  const date = chrono.parseDate(whenText, new Date(), { forwardDate: true });
  if (!date) {
    console.log("⛔ chrono failed to parse", whenRaw);
    return;
  }
  const epoch = Math.floor(date.getTime()/1000);
  if (epoch - Date.now()/1000 < 60) {
    console.log("⛔ time must be at least 60s in the future");
    return;
  }

  // Open (or fetch) a DM channel
  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  // Immediate DM confirmation
  await slack.chat.postMessage({
    channel: dm.id,
    text: `👍 Got it! I’ll remind you at ${date.toLocaleTimeString()}.`
  });

  // Schedule the reminder
  const resp = await slack.chat.scheduleMessage({
    channel: dm.id,
    text: `⏰ Reminder: ${message}`,
    post_at: epoch
  });
  console.log("scheduled message:", resp.scheduled_message_id);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
