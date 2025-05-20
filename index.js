// index.js — Slack DM Reminder Bot (self-reminders always allowed)
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
  res.send("Slack Reminder Bot up — POST only.")
);

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

  // 1) Strip only the bot’s own mention
  const botId     = event.authorizations?.[0]?.user_id;
  const mentionRE = /<@([A-Z0-9]+)>/g;
  const stripped  = event.text.replace(mentionRE, (m, id) =>
    id === botId ? "" : m
  ).trim();

  // 2) Determine target user
  let targetUser = event.user;                   // “me” case
  const extra    = stripped.match(mentionRE);    // explicit mention?
  if (extra) {
    targetUser = extra[0].replace(/[<@>]/g, "");
    // only now check if that explicit mention is a bot
    const { user } = await slack.users.info({ user: targetUser });
    if (user.is_bot) return bail("explicit target-is-bot");
  }

  // 3) Parse out “message … at time”
  const idx = stripped.toLowerCase().lastIndexOf(" at ");
  if (idx === -1)       return bail("no-at-keyword");
  const msg  = stripped.slice(0, idx).replace(/^remind\s+/i, "").trim();
  const when = stripped.slice(idx + 4).trim();
  if (!msg)  return bail("empty-msg");
  if (!when) return bail("empty-time");

  // 4) Convert to future date & ensure ≥60s ahead
  const date  = parseNatural(when);
  if (!date)  return bail("chrono-fail");
  const epoch = Math.floor(date.getTime() / 1000);
  if (epoch - Date.now()/1000 < 60) return bail("time-too-soon");

  // 5) Open (or fetch) the DM channel
  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  // 6) Immediate confirmation in the DM
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
