// index.js — Slack “I will do it” Reminder Bot with Moncton-aware scheduling + Zapier thread capture
// -------------------------------------------------------------------------
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import moment from "moment-timezone";
import morgan from "morgan";
import fetch from "node-fetch";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();
const ZAPIER_URL = "https://hooks.zapier.com/hooks/catch/15006197/uo22fas/";

app.use(express.json());
app.use(morgan("tiny"));

// Health-check
app.get("/slack/webhook", (_req, res) => res.send("Reminder bot is running."));

// Main event endpoint
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === "url_verification") return res.json({ challenge });
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }
  res.sendStatus(200);
});

// Send full thread content to Zapier
async function sendThreadToZapier(event) {
  const threadTs = event.thread_ts || event.ts;
  const replies  = await slack.conversations.replies({ channel: event.channel, ts: threadTs });
  const texts = replies.messages
    .filter(msg => msg.ts !== event.ts)
    .map(msg => msg.text)
    .join("\n\n");

  await fetch(ZAPIER_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ threadContent: texts })
  });
  console.log('✅ Thread sent to Zapier');
}

// Handle @botmention
async function handleMention(event) {
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text.replace(botTag, "").trim();

  // If in a thread and no remind command, just forward to Zapier
  const isRemind = /^remind\b/i.test(text);
  if (event.thread_ts && !isRemind) {
    await sendThreadToZapier(event);
    return;
  }

  // Parse "remind" commands
  const REMIND_RE = /remind\s+(?:<@([A-Z0-9]+)>|me)\s+(?:to\s+)?(.+?)\s+at\s+(.+)/i;
  const m = text.match(REMIND_RE);
  if (!m) return;

  const [, mentionedUser, taskText, timeRaw] = m;
  const targetUser = mentionedUser || event.user;
  const tz  = "America/Moncton";
  const now = moment().tz(tz);
  let scheduleMoment;

  // Absolute time
  const abs = timeRaw.match(/^\s*(\d{1,2}):(\d{2})\s*(am|pm)\s*$/i);
  if (abs) {
    let hour = parseInt(abs[1], 10) % 12;
    if (abs[3].toLowerCase() === "pm") hour += 12;
    scheduleMoment = now.clone().hour(hour).minute(parseInt(abs[2], 10)).second(0);
    if (scheduleMoment.isBefore(now)) scheduleMoment.add(1, "day");
  } else {
    let when = timeRaw.trim();
    if (/^\d+\s*(minutes?|hours?)$/i.test(when)) when = "in " + when;
    const parsed = chrono.parseDate(when, now.toDate(), { forwardDate: true });
    scheduleMoment = moment(parsed).tz(tz);
  }

  const delaySec = scheduleMoment.unix() - now.unix();
  if (delaySec < 60) return;

  // Acknowledge in thread
  await slack.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: "I will do it." });

  // Forward thread to Zapier as well
  await sendThreadToZapier(event);

  // Schedule DM reminder
  setTimeout(async () => {
    try {
      const { channel } = await slack.conversations.open({ users: targetUser });
      await slack.chat.postMessage({ channel: channel.id, text: `⏰ Reminder: ${taskText}` });
    } catch (e) {
      console.error("❌ failed to send reminder:", e);
    }
  }, delaySec * 1000);
}

// Launch server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
