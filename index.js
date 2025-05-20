// index.js — Slack DM Reminder Bot (self-reminders always allowed)
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));                         // logs each request

// Health-check (optional)
app.get("/slack/webhook", (_, res) =>
  res.send("Slack Reminder Bot up — send POSTs only.")
);

app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  // URL-verification handshake
  if (type === "url_verification") {
    return res.json({ challenge });
  }

  // Only handle app_mention events
  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(err =>
      console.error("handleMention error:", err)
    );
  }

  // Always 200 so Slack keeps sending events
  res.sendStatus(200);
});

const bail = reason => console.log("⛔ bail:", reason);
function parseNatural(str) {
  // help chrono with bare "2 minutes", "3 hours"
  if (/^\d+\s*(minutes?|hours?)$/i.test(str)) str = "in " + str;
  return chrono.parseDate(str, new Date(), { forwardDate: true });
}

async function handleMention(event) {
  console.log("🔔 handleMention called");
  console.log("full event text →", event.text);
  console.log("author →", event.user);

  // 1) Strip only the bot’s mention
  const botId     = event.authorizations?.[0]?.user_id;
  const botTagRE  = new RegExp(`<@${botId}>`, "g");
  let text        = event.text.replace(botTagRE, "").trim();

  // 2) Determine target user & message core
  let targetUser, core;
  const meRE = /^remind\s+me\s+/i;
  if (meRE.test(text)) {
    // "remind me ..." → DM the sender
    targetUser = event.user;
    core       = text.replace(meRE, "").trim();
  } else {
    // explicit "@user" case
    const mentionMatch = text.match(/<@([A-Z0-9]+)>/);
    if (!mentionMatch) return bail("no-target");
    targetUser = mentionMatch[1];
    core       = text.replace(mentionMatch[0], "").trim();

    // block true bots (but not self-reminders)
    const info = await slack.users.info({ user: targetUser });
    if (info.user?.is_bot) return bail("explicit target-is-bot");
  }

  // 3) Split on the last " at "
  const idx = core.toLowerCase().lastIndexOf(" at ");
  if (idx === -1)       return bail("no-at-keyword");
  const msg  = core.slice(0, idx).trim();
  const when = core.slice(idx + 4).trim();
  if (!msg)  return bail("empty-msg");
  if (!when) return bail("empty-time");

  // 4) Parse date & ensure ≥60s ahead
  const date  = parseNatural(when);
  if (!date)  return bail("chrono-fail");
  const epoch = Math.floor(date.getTime() / 1000);
  if (epoch - Date.now()/1000 < 60) return bail("time-too-soon");

  // 5) Open (or fetch) a DM channel
  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  // 6) Immediate DM confirmation
  await slack.chat.postMessage({
    channel: dm.id,
    text: `👍 Got it! I’ll remind you at ${date.toLocaleTimeString()}.`,
  });

  // 7) Schedule the actual reminder
  const resp = await slack.chat.scheduleMessage({
    channel: dm.id,
    text: `⏰ Reminder: ${msg}`,
    post_at: epoch,
  });
  console.log("scheduled:", resp.scheduled_message_id);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
