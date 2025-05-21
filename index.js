// index.js — Slack “I will do it” Reminder Bot with Moncton‐aware scheduling
// -------------------------------------------------------------------------
// 1) package.json must include:
// {
//   "type": "module",
//   "scripts": { "start": "node index.js" },
//   "dependencies": {
//     "@slack/web-api":    "^7.3.0",
//     "chrono-node":       "^2.7.8",
//     "moment-timezone":   "^0.5.43",
//     "express":           "^4.19.0",
//     "morgan":            "^1.10.0"
//   }
// }
//
// 2) In your environment (e.g. Render → Environment Variables):
//    SLACK_BOT_TOKEN = xoxb-…   (mark it Secret)
//
// 3) In your Slack App → OAuth & Permissions → Bot Token Scopes, add:
//    chat:write, im:read, im:write, users:read, channels:read, channels:history
//    then Reinstall to Workspace
//
// 4) In your Slack App → Event Subscriptions, subscribe to “app_mention” and
//    set Request URL to https://<your-domain>/slack/webhook
//
// 5) Invite your bot to any channel you test in: `/invite @YourBot`

import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import moment from "moment-timezone";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));

// Health-check endpoint (optional)
app.get("/slack/webhook", (_req, res) =>
  res.send("Reminder bot is running. POST events to /slack/webhook.")
);

// Main Slack Events endpoint
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  // 1) URL verification handshake
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // 2) Only handle bot mentions
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }

  // 3) Always acknowledge
  res.sendStatus(200);
});

async function handleMention(event) {
  console.log("🔔 handleMention called:", event.text);

  // Strip only the bot’s mention
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text.replace(botTag, "").trim();

  // Match "remind me ... at ..." or "remind @user ... at ..."
  const REMIND_RE = /remind\s+(?:<@([A-Z0-9]+)>|me)\s+(?:to\s+)?(.+?)\s+at\s+(.+)/i;
  const m         = text.match(REMIND_RE);
  if (!m) {
    console.log("⛔ did not match remind pattern");
    return;
  }

  // Determine target user and task/time
  const [, mentionedUser, taskText, timeRaw] = m;
  const targetUser = mentionedUser || event.user;

  // Parse scheduling time in Moncton timezone
  const tz  = "America/Moncton";
  const now = moment().tz(tz);

  let scheduleMoment;
  // Absolute time like "9:30 pm"
  const abs = timeRaw.match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/i);
  if (abs) {
    let hour = parseInt(abs[1], 10) % 12;
    if (abs[3].toLowerCase() === "pm") hour += 12;
    scheduleMoment = now.clone().hour(hour).minute(parseInt(abs[2], 10)).second(0);
    if (scheduleMoment.isBefore(now)) {
      scheduleMoment.add(1, "day");
    }
  } else {
    // Relative time fallback, e.g. "in 2 minutes"
    let when = timeRaw.trim();
    if (/^\d+\s*(minutes?|hours?)$/i.test(when)) {
      when = "in " + when;
    }
    const parsed = chrono.parseDate(when, now.toDate(), { forwardDate: true });
    if (!parsed) {
      console.log("⛔ chrono failed to parse time:", timeRaw);
      return;
    }
    scheduleMoment = moment(parsed).tz(tz);
  }

  const delaySec = scheduleMoment.unix() - now.unix();
  if (delaySec < 60) {
    console.log("⛔ scheduled time must be at least 60s in the future");
    return;
  }

  console.log(`⏳ scheduling local reminder for ${delaySec}s at ${scheduleMoment.format()}`);

  // 1) Reply "I will do it." in thread
  await slack.chat.postMessage({
    channel:   event.channel,
    thread_ts: event.ts,
    text:      "I will do it.",
  });

  // 2) Schedule the DM
  setTimeout(async () => {
    try {
      const { channel } = await slack.conversations.open({ users: targetUser });
      await slack.chat.postMessage({
        channel: channel.id,
        text:    `⏰ Reminder: ${taskText}`,
      });
      console.log("✅ reminder sent to", targetUser);
    } catch (e) {
      console.error("❌ failed to send reminder:", e);
    }
  }, delaySec * 1000);
}

// Start the HTTP server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
