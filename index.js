// index.js — Slack DM Reminder Bot with DM‐fallback
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
  res.send("Reminder bot is running. POST to /slack/webhook.")
);

// Main endpoint
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

function parseTime(str) {
  if (/^\d+\s*(m(in(ute)?s?)?|h(ours?)?)$/i.test(str)) str = "in " + str;
  return chrono.parseDate(str, new Date(), { forwardDate: true });
}

async function handleMention(event) {
  console.log("🔔 handleMention called:", event.text);

  // 1) Strip only the bot’s mention
  const botId  = event.authorizations?.[0]?.user_id;
  const botTag = `<@${botId}>`;
  let text     = event.text.replace(botTag, "").trim();

  // 2) Determine target and coreText
  let targetUser, coreText;
  if (/^remind\s+me\s+/i.test(text)) {
    targetUser = event.user;
    coreText   = text.replace(/^remind\s+me\s+/i, "").trim();
  } else {
    const m = text.match(/<@([A-Z0-9]+)>/);
    if (!m) {
      console.log("⛔ no user mention");
      return;
    }
    targetUser = m[1];
    coreText   = text.replace(m[0], "").trim();
  }

  // 3) Split on the last " at "
  const idx = coreText.toLowerCase().lastIndexOf(" at ");
  if (idx < 0) {
    console.log("⛔ missing ‘at’");
    return;
  }
  const message = coreText.slice(0, idx).trim();
  const whenRaw = coreText.slice(idx + 4).trim();
  if (!message || !whenRaw) {
    console.log("⛔ empty message or time");
    return;
  }

  // 4) Parse date & ensure ≥60s ahead
  const date  = parseTime(whenRaw);
  if (!date) {
    console.log("⛔ time parse failed");
    return;
  }
  const postAt = Math.floor(date.getTime() / 1000);
  if (postAt - Date.now()/1000 < 60) {
    console.log("⛔ time too soon");
    return;
  }

  // 5) Try DM, else fallback to channel
  let channelId = event.channel;
  let threadTs  = event.ts;
  let isFallback = false;

  try {
    const { channel } = await slack.conversations.open({ users: targetUser });
    channelId = channel.id;
    threadTs  = undefined;      // no thread in a DM
  } catch (err) {
    if (err.data?.error === "cannot_dm_bot") {
      console.log("⚠️ cannot_dm_bot — will post in channel instead");
      isFallback = true;
      // channelId stays as event.channel, threadTs stays event.ts
    } else {
      throw err;
    }
  }

  // 6) Send immediate confirmation
  const confirmText = isFallback
    ? `👍 Got it! I’ll remind <@${targetUser}> at ${date.toLocaleTimeString()} right here.`
    : `👍 Got it! I’ll remind you at ${date.toLocaleTimeString()}.`;

  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: confirmText,
  });

  // 7) Schedule the reminder
  const reminderText = isFallback
    ? `⏰ Reminder for <@${targetUser}>: ${message}`
    : `⏰ Reminder: ${message}`;

  const resp = await slack.chat.scheduleMessage({
    channel: channelId,
    post_at: postAt,
    text: reminderText,
  });

  console.log("scheduled message:", resp.scheduled_message_id);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
