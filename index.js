// index.js — Slack “I will do it” Reminder Bot with Moncton‑aware scheduling
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
//     "morgan":            "^1.10.0",
//     "node-fetch":        "^3.3.1"
//   }
// }
// ...and ensure SLACK_BOT_TOKEN is set in your environment.

import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import moment from "moment-timezone";
import morgan from "morgan";
import fetch from "node-fetch"; // for sending to Zapier

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));

// Health-check endpoint
app.get("/slack/webhook", (_req, res) =>
  res.send("Reminder bot is running. POST events to /slack/webhook.")
);

// Main Slack Events endpoint
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  // URL verification handshake
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // Only handle bot mentions
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }

  // Always acknowledge
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

  const [, mentionedUser, taskText, timeRaw] = m;
  const targetUser = mentionedUser || event.user;

  // Parse scheduling time in Moncton timezone
  const tz  = "America/Moncton";
  const now = moment().tz(tz);

  let scheduleMoment;
  const abs = timeRaw.match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/i);
  if (abs) {
    let hour = parseInt(abs[1], 10) % 12;
    if (abs[3].toLowerCase() === "pm") hour += 12;
    scheduleMoment = now.clone().hour(hour).minute(parseInt(abs[2], 10)).second(0);
    if (scheduleMoment.isBefore(now)) {
      scheduleMoment.add(1, "day");
    }
  } else {
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

  // 2) Fetch entire thread and send to Zapier for formatting
  try {
    const threadTs = event.thread_ts || event.ts;
    const replies  = await slack.conversations.replies({ channel: event.channel, ts: threadTs });
    const texts    = replies.messages
      .filter(msg => msg.ts !== event.ts)
      .map(msg => msg.text)
      .join("\n\n");

    await fetch("https://hooks.zapier.com/hooks/catch/15006197/uo22fas/", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ threadContent: texts }),
    });
    console.log('✅ Thread content sent to Zapier');
  } catch (err) {
    console.error('❌ Error sending thread to Zapier:', err);
  }

  // 3) Schedule the DM reminder
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
