// index.js — Slack Reminder Bot with timezone-aware absolute times
// -------------------------------------------------------------------------
// 1) Ensure package.json has:
// {
//   "type": "module",
//   "dependencies": {
//     "@slack/web-api": "^7.3.0",
//     "chrono-node":   "^2.7.8",
//     "moment-timezone": "^0.5.43",
//     "express":       "^4.19.0",
//     "morgan":        "^1.10.0"
//   }
// }
// 2) Install new dependency:
//    npm install moment-timezone
// 3) ENV var:
//    SLACK_BOT_TOKEN = xoxb-… (Secret)
// 4) Slack scopes:
//    chat:write, im:read, im:write, users:read, channels:read, channels:history
//    (reinstall after adding scopes)
// 5) Subscribe to app_mention event and invite bot to channel.

import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import moment from "moment-timezone";
import morgan from "morgan";

// Fixed timezone for parsing absolute times
const USER_TIMEZONE = "America/Moncton";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));

// Health-check
app.get("/slack/webhook", (_, res) =>
  res.send("Reminder bot running. POST to /slack/webhook.")
);

app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === "url_verification") {
    return res.json({ challenge });
  }
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }
  res.sendStatus(200);
});

async function handleMention(event) {
  console.log("🔔 handleMention called:", event.text);

  // Strip only bot's mention
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text.replace(botTag, "").trim();

  // Unified regex for both "me" and "@user"
  const remindRE = /remind\s+(?:<@([A-Z0-9]+)>|me)\s+(?:to\s+)?(.+?)\s+at\s+(.+)/i;
  const m        = text.match(remindRE);
  if (!m) {
    console.log("⛔ no remind pattern match");
    return;
  }

  const [, mentionedUser, taskText, timeRaw] = m;
  const targetUser = mentionedUser || event.user;

  // Determine scheduled date
  let date = null;
  const raw = timeRaw.trim();

  // Absolute time e.g. "9:53 pm" or "9 pm"
  if (/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(raw)) {
    // Choose format based on presence of minutes
    const fmt = raw.includes(":") ? "h:mm a" : "h a";
    let mDate = moment.tz(raw, fmt, USER_TIMEZONE);
    // If parsed time is before now in that tz, add a day
    if (mDate.isBefore(moment.tz(USER_TIMEZONE))) {
      mDate = mDate.add(1, "day");
    }
    date = mDate.toDate();
  } else {
    // Relative expressions via chrono
    let whenText = raw;
    if (/^\d+\s*(minutes?|hours?)$/i.test(whenText)) {
      whenText = "in " + whenText;
    }
    date = chrono.parseDate(whenText, new Date(), { forwardDate: true });
  }

  if (!date) {
    console.log("⛔ time parse failed:", timeRaw);
    return;
  }

  const postAt = Math.floor(date.getTime() / 1000);
  if (postAt - Date.now() / 1000 < 60) {
    console.log("⛔ scheduled time must be ≥ 60s in the future");
    return;
  }

  // Reply in-thread
  await slack.chat.postMessage({
    channel:   event.channel,
    thread_ts: event.ts,
    text:      "I will do it.",
  });

  // Open DM or fallback
  let channelId = event.channel;
  try {
    const { channel } = await slack.conversations.open({ users: targetUser });
    channelId = channel.id;
  } catch (err) {
    console.log("⚠️ cannot open DM, using channel instead");
  }

  // Schedule reminder message
  const resp = await slack.chat.scheduleMessage({
    channel: channelId,
    text:    `⏰ Reminder: ${taskText}`,
    post_at: postAt,
  });
  console.log("scheduled reminder:", resp.scheduled_message_id);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
