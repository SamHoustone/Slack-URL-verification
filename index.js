// index.js — Slack “I will do it” Bot + Zapier JSON reply
// -------------------------------------------------------------------------
import express from "express";
import { WebClient } from "@slack/web-api";
import morgan from "morgan";

// Environment variables:
//   SLACK_BOT_TOKEN — your Slack bot token
//   ZAPIER_URL      — Zapier hook URL (not used here)
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

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

// Zapier endpoint: receives { channel, thread_ts, ...data }
app.post("/slack/zapier", async (req, res) => {
  const payload = req.body;
  const { channel, thread_ts } = payload;

  if (!channel || !thread_ts) {
    return res.status(400).json({ error: "Missing channel or thread_ts" });
  }

  // Construct reply text from payload (excluding channel/thread_ts)
  const replyData = { ...payload };
  delete replyData.channel;
  delete replyData.thread_ts;

  const text = 'Received data: ' + JSON.stringify(replyData, null, 2);

  try {
    await slack.chat.postMessage({ channel, thread_ts, text });
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error replying to thread:", err);
    res.status(500).json({ error: err.data || err.message });
  }
});

// Processes @botmention events
async function handleMention(event) {
  const botTag = `<@${event.authorizations?.[0]?.user_id}>`;
  const text   = event.text.replace(botTag, "").trim();

  // Forward all mentions to Zapier
  const webhookUrl = process.env.ZAPIER_URL;
  const threadTs = event.thread_ts || event.ts;

  // Fetch thread messages
  const resp = await slack.conversations.replies({ channel: event.channel, ts: threadTs });
  const threadText = resp.messages.map(m => m.text).join("\n\n");

  // Send to Zapier
  await fetch(webhookUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ channel: event.channel, thread_ts: threadTs, content: threadText })
  });
}

// Start the HTTP server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
