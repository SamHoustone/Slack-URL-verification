// index.js — “I will do it” Reminder Bot
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));

// Health-check (optional)
app.get("/slack/webhook", (_, res) =>
  res.send("Reminder bot is running. POST events to /slack/webhook.")
);

// Main webhook endpoint
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === "url_verification") return res.json({ challenge });
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }
  res.sendStatus(200);
});

async function handleMention(event) {
  console.log("🔔 handleMention called:", event.text);

  // 1) Strip only the bot’s mention
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text;
  const i      = text.indexOf(botTag);
  if (i !== -1) text = text.slice(i + botTag.length).trim();

  // 2) Match either “remind me … at …” or “remind @user … at …”
  const remindMeRE   = /^(?:please\s+)?remind\s+me\s+(?:to\s+)?(.+?)\s+at\s+(.+)$/i;
  const remindUserRE = /^(?:please\s+)?remind\s+<@([A-Z0-9]+)>\s+(?:to\s+)?(.+?)\s+at\s+(.+)$/i;
  let targetUser, taskText, timeRaw, m;

  if ((m = text.match(remindMeRE))) {
    targetUser = event.user;
    taskText   = m[1];
    timeRaw    = m[2];
  } else if ((m = text.match(remindUserRE))) {
    targetUser = m[1];
    taskText   = m[2];
    timeRaw    = m[3];
  } else {
    console.log("⛔ did not match remind pattern");
    return;
  }

  // 3) Parse the time naturally
  let whenText = timeRaw.trim();
  if (/^\d+\s*(minutes?|hours?)$/i.test(whenText)) {
    whenText = "in " + whenText;
  }
  const date = chrono.parseDate(whenText, new Date(), { forwardDate: true });
  if (!date) {
    console.log("⛔ time parse failed:", timeRaw);
    return;
  }
  const postAt = Math.floor(date.getTime() / 1000);
  if (postAt - Date.now()/1000 < 60) {
    console.log("⛔ scheduled time must be at least 60s in the future");
    return;
  }

  // 4) Reply “I will do it.” in-thread
  await slack.chat.postMessage({
    channel:   event.channel,
    thread_ts: event.ts,
    text:      "I will do it.",
  });

  // 5) Try to open a DM, fallback to channel if it errors
  let channelId = event.channel;
  try {
    const { channel } = await slack.conversations.open({ users: targetUser });
    channelId = channel.id;
  } catch (err) {
    console.log("⚠️ cannot open DM, will post in channel instead");
  }

  // 6) Schedule the reminder (DM or channel)
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
