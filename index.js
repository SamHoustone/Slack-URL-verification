// index.js — Slack DM Reminder Bot (self-reminders always allowed)
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));                           // logs each request

// Health-check (GET)
app.get("/slack/webhook", (_, res) =>
  res.send("Slack Reminder Bot up — POST only.")
);

// Main webhook endpoint (POST)
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") {
    return res.json({ challenge });
  }

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
  if (/^\d+\s*(minutes?|hours?)$/i.test(str)) str = "in " + str;
  return chrono.parseDate(str, new Date(), { forwardDate: true });
}

async function handleMention(event) {
  console.log("🔔 handleMention called");
  console.log("full event text →", event.text);
  console.log("author →", event.user);

  // 1) Remove only the bot’s mention, leave any other <@U…> intact
  const botId     = event.authorizations?.[0]?.user_id;
  const mentionRE = /<@([A-Z0-9]+)>/g;
  const stripped  = event.text.replace(mentionRE, (m, id) =>
    id === botId ? "" : m
  ).trim();

  // 2) Figure out who to remind
  let targetUser = event.user;                // default = sender (“me”)
  const extra    = stripped.match(mentionRE); // any other @mention?
  if (extra) {
    targetUser = extra[0].replace(/[<@>]/g, "");
    // fetch that user's info
    const info = await slack.users.info({ user: targetUser });
    // only block if it's a bot *and* not the sender themselves
    if (info.user?.is_bot && targetUser !== event.user) {
      return bail("explicit target-is-bot");
    }
  }

  // 3) Split on the last “ at ”
  const idx = stripped.toLowerCase().lastIndexOf(" at ");
  if (idx === -1)       return bail("no-at-keyword");

  const msg  = stripped.slice(0, idx).replace(/^remind\s+/i, "").trim();
  const when = stripped.slice(idx + 4).trim();
  if (!msg)  return bail("empty-msg");
  if (!when) return bail("empty-time");

  // 4) Parse time & ensure ≥ 60s in the future
  const date  = parseNatural(when);
  if (!date)  return bail("chrono-fail");
  const epoch = Math.floor(date.getTime() / 1000);
  if (epoch - Date.now() / 1000 < 60) return bail("time-too-soon");

  // 5) Open (or fetch) the DM channel with that user
  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  // 6) Send immediate confirmation in the DM
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
