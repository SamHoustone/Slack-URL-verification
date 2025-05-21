// index.js — consolidated Reminder Bot
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));

// Health-check
app.get("/slack/webhook", (_, res) =>
  res.send("Reminder bot running. POST to /slack/webhook.")
);

// Webhook endpoint
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
  // Grab just the raw message text
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text.replace(botTag, "").trim();

  console.log("🔔 stripped text →", text);

  // Match both "remind me ..." and "remind @user ..."
  const remindRE = /remind\s+(?:<@([A-Z0-9]+)>|me)\s+(?:to\s+)?(.+?)\s+at\s+(.+)/i;
  const m        = text.match(remindRE);
  if (!m) {
    console.log("⛔ no remind pattern match");
    return;
  }

  // Determine target
  const [, mentionedUser, taskText, timeRaw] = m;
  const targetUser = mentionedUser || event.user;

  // Normalize time for chrono
  let whenText = timeRaw.trim();
  if (/^\d+\s*(minutes?|hours?)$/i.test(whenText)) {
    whenText = "in " + whenText;
  }
  const date = chrono.parseDate(whenText, new Date(), { forwardDate: true });
  if (!date) {
    console.log("⛔ chrono failed to parse time:", timeRaw);
    return;
  }
  const postAt = Math.floor(date.getTime()/1000);
  if (postAt - Date.now()/1000 < 60) {
    console.log("⛔ time must be ≥60s in the future");
    return;
  }

  // 1) Reply in-thread
  await slack.chat.postMessage({
    channel:   event.channel,
    thread_ts: event.ts,
    text:      "I will do it.",
  });

  // 2) Try DM, else channel fallback
  let channelId = event.channel;
  try {
    const { channel } = await slack.conversations.open({ users: targetUser });
    channelId = channel.id;
  } catch (err) {
    console.log("⚠️ cannot open DM, using channel instead");
  }

  // 3) Schedule the reminder
  const resp = await slack.chat.scheduleMessage({
    channel: channelId,
    text:    `⏰ Reminder: ${taskText}`,
    post_at: postAt,
  });
  console.log("scheduled reminder:", resp.scheduled_message_id);
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
