// index.js — Slack “I will do it” Bot + Zapier JSON -> Personal DM
// -------------------------------------------------------------------------
import express from "express";
import { WebClient } from "@slack/web-api";
import morgan from "morgan";
import fetch from "node-fetch";

// Environment variables:
//   SLACK_BOT_TOKEN — your Slack bot token
//   ZAPIER_URL      — Zapier hook URL
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();
const ZAPIER_URL = process.env.ZAPIER_URL;

app.use(express.json());
app.use(morgan("tiny"));

// Health-check endpoint
app.get("/slack/webhook", (_req, res) => res.send("Reminder bot is running."));

// Slack Events endpoint
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === "url_verification") {
    return res.json({ challenge });
  }
  if (type === "event_callback" && event.type === "app_mention") {
    handleMention(event).catch(console.error);
  }
  res.sendStatus(200);
});

// Zapier endpoint: receives { userId, ...data }
app.post("/slack/zapier", async (req, res) => {
  console.log("⏳ Received /slack/zapier payload:", req.body);
  const { userId, ...data } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "Missing userId in payload" });
  }

  // Format data for DM
  const text = "Received data: " + JSON.stringify(data, null, 2);

  try {
    // Open DM channel to the user
    const dm = await slack.conversations.open({ users: userId });
    await slack.chat.postMessage({ channel: dm.channel.id, text });
    console.log(`✅ Sent DM to ${userId}`);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error sending DM:", err);
    res.status(500).json({ error: err.data || err.message });
  }
});

// Helper: forwards entire Slack thread to Zapier for parsing
async function sendThreadToZapier(event) {
  const threadTs = event.thread_ts || event.ts;
  const resp     = await slack.conversations.replies({ channel: event.channel, ts: threadTs });
  const content  = resp.messages
    .filter(msg => msg.ts !== event.ts)
    .map(msg => msg.text)
    .join("\n\n");

  await fetch(ZAPIER_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ userId: event.user, content })
  });
  console.log("✅ Thread sent to Zapier");
}

// Processes @botmention events
async function handleMention(event) {
  try {
    await sendThreadToZapier(event);
  } catch (err) {
    console.error("❌ Error in handleMention:", err);
  }
}

// Start the HTTP server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
