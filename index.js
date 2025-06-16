// index.js — Slack “I will do it” Bot + Zapier JSON endpoint for scheduling reminders
// -------------------------------------------------------------------------
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import moment from "moment-timezone";
import morgan from "morgan";
import fetch from "node-fetch";

// Environment variables:
//   SLACK_BOT_TOKEN — your Slack bot token
//   ZAPIER_URL      — Zapier hook URL
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();
const ZAPIER_URL = process.env.ZAPIER_URL || "https://hooks.zapier.com/hooks/catch/15006197/uo22fas/";

app.use(express.json());
app.use(morgan("tiny"));

// Health-check endpoint
app.get("/slack/webhook", (_req, res) => res.send("Reminder bot is running."));

// Slack Events endpoint
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === "url_verification") return res.json({ challenge });
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }
  res.sendStatus(200);
});

// Zapier endpoint: receives { userId?, channel?, thread_ts?, name, phone, callback_time }
app.post("/slack/zapier", async (req, res) => {
  const { userId, channel, thread_ts, name, phone, callback_time } = req.body;
  try {
    const tz = "America/Moncton";
    const m  = moment.tz(callback_time, tz);
    const postAt = m.unix();

    if (channel && thread_ts) {
      // Schedule message in the original thread
      await slack.chat.scheduleMessage({
        channel,
        post_at: postAt,
        text: `⏰ *Callback Reminder*\n• *Name:* ${name}\n• *Phone:* ${phone}\n• *Requested:* ${m.format("YYYY-MM-DD HH:mm")}`,
        thread_ts: thread_ts
      });
      console.log(`✅ Scheduled thread reminder in ${channel}@${thread_ts}`);
    } else if (userId) {
      // Fallback: open DM and schedule there
      const dm = await slack.conversations.open({ users: userId });
      await slack.chat.scheduleMessage({
        channel: dm.channel.id,
        post_at: postAt,
        text: `⏰ *Callback Reminder*\n• *Name:* ${name}\n• *Phone:* ${phone}\n• *Requested:* ${m.format("YYYY-MM-DD HH:mm")}`
      });
      console.log(`✅ Scheduled DM reminder for ${userId}`);
    } else {
      throw new Error('No target specified (userId or channel/thread_ts required)');
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error scheduling callback:", err);
    res.status(500).json({ error: err.data || err.message });
  }
});

// Helper: forwards entire Slack thread to Zapier for parsing
async function sendThreadToZapier(event) {
  const threadTs = event.thread_ts || event.ts;
  const resp     = await slack.conversations.replies({ channel: event.channel, ts: threadTs });
  const texts    = resp.messages
    .filter(msg => msg.ts !== event.ts)
    .map(msg => msg.text)
    .join("\n\n");

  await fetch(ZAPIER_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ threadContent: texts, channel: event.channel, thread_ts: threadTs })
  });

  console.log("✅ Thread sent to Zapier");
}

// Processes @botmention events
async function handleMention(event) {
  const botTag = `<@${event.authorizations?.[0]?.user_id}>`;
  const text   = event.text.replace(botTag, "").trim();

  // If not a "remind" command, forward thread
  if (!/^remind\b/i.test(text)) {
    await sendThreadToZapier(event);
    return;
  }

  // Parse "remind me to ... at ..." or "remind @user ... at ..."
  const REMIND_RE = /remind\s+(?:<@([A-Z0-9]+)>|me)\s+(?:to\s+)?(.+?)\s+at\s+(.+)/i;
  const m = text.match(REMIND_RE);
  if (!m) return;

  const [, mentionedUser, taskText, timeRaw] = m;
  const targetUser = mentionedUser || event.user;
  const tz  = "America/Moncton";
  const now = moment().tz(tz);
  let scheduleMoment;

  // Check for HH:MM am/pm
  const abs = timeRaw.match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/i);
  if (abs) {
    let hour = parseInt(abs[1], 10) % 12;
    if (abs[3].toLowerCase() === "pm") hour += 12;
    scheduleMoment = now.clone().hour(hour).minute(parseInt(abs[2], 10)).second(0);
    if (scheduleMoment.isBefore(now)) scheduleMoment.add(1, "day");
  } else {
    // Fallback: natural language
    let when = timeRaw.trim();
    if (/^\d+\s*(minutes?|hours?)$/i.test(when)) when = `in ${when}`;
    const parsed = chrono.parseDate(when, now.toDate(), { forwardDate: true });
    scheduleMoment = moment(parsed).tz(tz);
  }

  const delaySec = scheduleMoment.unix() - now.unix();
  if (delaySec < 60) return;

  // Acknowledge
  await slack.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "I will do it." });

  // Forward thread for parsing
  await sendThreadToZapier(event);

  // Schedule DM reminder locally
  setTimeout(async () => {
    try {
      const dm = await slack.conversations.open({ users: targetUser });
      await slack.chat.postMessage({ channel: dm.channel.id, text: `⏰ Reminder: ${taskText}` });
    } catch (e) {
      console.error("❌ failed to send reminder:", e);
    }
  }, delaySec * 1000);
}

// Start the HTTP server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
