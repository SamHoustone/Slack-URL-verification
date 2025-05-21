// index.js — Slack Reminder Bot (“I will do it” + DM at scheduled time)
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const app   = express();
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

app.use(express.json());
app.use(morgan("tiny"));

// Health-check for browser
app.get("/slack/webhook", (_, res) =>
  res.send("Reminder bot alive. POST events to /slack/webhook.")
);

// Main webhook endpoint
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  // 1. URL verification
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // 2. Handle app_mention events only
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(err =>
      console.error("handleMention error:", err)
    );
  }

  // 3. Always respond 200 OK
  res.sendStatus(200);
});

async function handleMention(event) {
  console.log("🔔 handleMention called:", event.text);

  // Strip only the bot mention
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = new RegExp(`<@${botId}>`, "g");
  let text     = event.text.replace(botTag, "").trim();

  // Regex to capture: optional “please ”, then “remind @user”, optional “to ”,
  // then the task, then “ at ”, then time expression
  const remindRE = /^(?:please\s+)?remind\s+<@([A-Z0-9]+)>\s+(?:to\s+)?(.+?)\s+at\s+(.+)$/i;
  const match    = text.match(remindRE);
  if (!match) {
    console.log("⛔ did not match remind pattern");
    return;
  }
  const [, targetUser, taskText, timeRaw] = match;

  // Parse natural-language time
  let whenText = timeRaw.trim();
  if (/^\d+\s*(minutes?|hours?)$/i.test(whenText)) {
    whenText = "in " + whenText;
  }
  const date = chrono.parseDate(whenText, new Date(), { forwardDate: true });
  if (!date) {
    console.log("⛔ chrono failed to parse:", timeRaw);
    return;
  }
  const postAt = Math.floor(date.getTime() / 1000);
  if (postAt - Date.now() / 1000 < 60) {
    console.log("⛔ scheduled time must be ≥60s in the future");
    return;
  }

  // 1) Reply “I will do it.” in-thread
  await slack.chat.postMessage({
    channel:   event.channel,
    thread_ts: event.ts,
    text:      "I will do it.",
  });

  // 2) Open DM with the target user
  let dmChannelId;
  try {
    const { channel } = await slack.conversations.open({ users: targetUser });
    dmChannelId = channel.id;
  } catch (err) {
    console.error("⚠️ unable to open DM:", err.data?.error);
    return;
  }

  // 3) Schedule the DM reminder
  const resp = await slack.chat.scheduleMessage({
    channel: dmChannelId,
    text:    `⏰ Reminder: ${taskText}`,
    post_at: postAt,
  });
  console.log("scheduled reminder:", resp.scheduled_message_id);
}

// Start the server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
