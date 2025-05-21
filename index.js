// index.js — Slack Reminder Bot (“I will do it” + DM at scheduled time)
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));

// Health‐check (optional)
app.get("/slack/webhook", (_, res) =>
  res.send("Reminder bot up. POST events to /slack/webhook.")
);

app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  // Slack handshake
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // Only handle @bot mentions
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(console.error);
  }

  // Always 200 OK
  res.sendStatus(200);
});

async function handleMention(event) {
  console.log("🔔 handleMention called:", event.text);

  // 1) Strip *only* the bot’s mention
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text.replace(botTag, "").trim();

  // 2) Extract target user and the reminder text+time
  //    Expect: “please remind @U123 to do X at TIME”
  const remindRE = /remind\s+<@([A-Z0-9]+)>\s+(.*)\s+at\s+(.+)$/i;
  const m = text.match(remindRE);
  if (!m) {
    console.log("⛔ did not match remind pattern");
    return;
  }
  const [, targetUser, taskText, timeRaw] = m;

  // 3) Parse time with chrono
  let timeStr = timeRaw.trim();
  if (/^\d+\s*(minutes?|hours?)$/i.test(timeStr)) {
    timeStr = "in " + timeStr;
  }
  const date = chrono.parseDate(timeStr, new Date(), { forwardDate: true });
  if (!date) {
    console.log("⛔ time parse failed:", timeRaw);
    return;
  }
  const postAt = Math.floor(date.getTime() / 1000);
  if (postAt - Date.now() / 1000 < 60) {
    console.log("⛔ scheduled time must be ≥60s in the future");
    return;
  }

  // 4) Reply to the original message in-thread
  await slack.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: "I will do it.",
  });

  // 5) Open (or fetch) a DM channel with the target user
  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  // 6) Schedule the actual reminder DM
  const resp = await slack.chat.scheduleMessage({
    channel: dm.id,
    text: `⏰ Reminder: ${taskText}`,
    post_at: postAt,
  });
  console.log("scheduled reminder:", resp.scheduled_message_id);
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
