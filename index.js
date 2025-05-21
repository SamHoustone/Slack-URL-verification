// index.js — Slack Reminder Bot with local scheduling
// Uses moment-timezone for absolute times in America/Moncton
// and chrono-node for relative times

import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import moment from "moment-timezone";
import morgan from "morgan";

const USER_TIMEZONE = "America/Moncton";
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();
app.use(express.json());
app.use(morgan("tiny"));

// Health check endpoint
app.get("/slack/webhook", (_, res) =>
  res.send("Reminder bot running. POST events to /slack/webhook.")
);

// Main webhook endpoint
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

  // Strip only bot mention
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text.replace(botTag, "").trim();

  // Regex for both "me" and "@user"
  const remindRE = /remind\s+(?:<@([A-Z0-9]+)>|me)\s+(?:to\s+)?(.+?)\s+at\s+(.+)/i;
  const m        = text.match(remindRE);
  if (!m) {
    console.log("⛔ no remind pattern match");
    return;
  }
  const [, mentionedUser, taskText, timeRaw] = m;
  const targetUser = mentionedUser || event.user;

  // Determine scheduled Date
  let date = null;
  const raw = timeRaw.trim();

  // Absolute times
  if (/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(raw)) {
    const fmt = raw.includes(":") ? "h:mm a" : "h a";
    let mDate = moment.tz(raw, fmt, USER_TIMEZONE);
    if (mDate.isBefore(moment.tz(USER_TIMEZONE))) mDate = mDate.add(1, "day");
    date = mDate.toDate();
  } else {
    // Relative expressions
    let whenText = raw;
    if (/^\d+\s*(minutes?|hours?)$/i.test(whenText)) whenText = "in " + whenText;
    date = chrono.parseDate(whenText, new Date(), { forwardDate: true });
  }

  if (!date) {
    console.log("⛔ time parse failed:", timeRaw);
    return;
  }

  const delayMs = date.getTime() - Date.now();
  if (delayMs < 60000) {
    console.log("⛔ scheduled time must be at least 60s in the future");
    return;
  }

  // Reply "I will do it." in-thread
  await slack.chat.postMessage({
    channel:   event.channel,
    thread_ts: event.ts,
    text:      "I will do it.",
  });

  // Open DM channel
  let dmChannel;
  try {
    const { channel } = await slack.conversations.open({ users: targetUser });
    dmChannel = channel.id;
  } catch (e) {
    console.error("⚠️ cannot open DM:", e.data?.error);
    return;
  }

  // Schedule local reminder
  console.log(`⏳ scheduling local reminder for ${delayMs/1000}s`);
  setTimeout(async () => {
    try {
      await slack.chat.postMessage({
        channel: dmChannel,
        text:    `⏰ Reminder: ${taskText}`,
      });
      console.log("✅ sent local reminder to", targetUser);
    } catch (err) {
      console.error("❌ failed to send local reminder:", err);
    }
  }, delayMs);
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
