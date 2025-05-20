// index.js  —  Slack DM Reminder Bot
import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));                           // logs each request line

/* health-check for browser GET */
app.get("/slack/webhook", (_, res) =>
  res.send("Slack Reminder Bot up — POST only.")
);

/* Slack sends all events here */
app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") return res.json({ challenge });

  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(err =>
      console.error("handleMention error:", err)
    );
  }
  res.sendStatus(200);                             // ALWAYS 200
});

/* ---------- helper utils ---------- */
const bail = reason => console.log("⛔ bail:", reason);

function parseNatural(str) {
  // help chrono parse bare "2 minutes", "3 hours"
  if (/^\d+\s*(minutes?|hours?)$/i.test(str)) str = "in " + str;
  return chrono.parseDate(str, new Date(), { forwardDate: true });
}
/* ----------------------------------- */

/* -------- core logic --------------- */
async function handleMention(event) {
  console.log("🔔 handleMention called");
  console.log("full event text →", event.text);
  console.log("author →", event.user);

  const botId = event.authorizations?.[0]?.user_id;

  // strip only the bot's own mention
  const mentionRE = /<@([A-Z0-9]+)>/g;
  const stripped  = event.text.replace(mentionRE, (m, id) => (id === botId ? "" : m)).trim();

  // target user: default to sender, override if another @user present
  let targetUser = event.user;
  const extraMention = stripped.match(mentionRE);
  if (extraMention) targetUser = extraMention[0].replace(/[<@>]/g, "");

  // fetch profile to see if Slack thinks target is a bot
  const { user } = await slack.users.info({ user: targetUser });

  // ⬇️ NEW — allow "me" even if Slack says is_bot
  if (user.is_bot && targetUser !== event.user) return bail("target-is-bot");

  /* ---------- split “message … at …” ---------- */
  const idx = stripped.toLowerCase().lastIndexOf(" at ");
  if (idx === -1)       return bail("no-at-keyword");

  const msg  = stripped.slice(0, idx).replace(/^remind\s+/i, "").trim();
  const when = stripped.slice(idx + 4).trim();
  if (!msg)  return bail("empty-msg");
  if (!when) return bail("empty-time");

  const date  = parseNatural(when);
  if (!date)  return bail("chrono-fail");
  const epoch = Math.floor(date.getTime() / 1000);
  if (epoch - Date.now() / 1000 < 60) return bail("time-too-soon");

  /* ---------- DM & scheduling ---------- */
  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  await slack.chat.postMessage({
    channel: dm.id,
    text: `👍 Got it! I’ll remind you at ${date.toLocaleTimeString()}.`,
  });

  const resp = await slack.chat.scheduleMessage({
    channel: dm.id,
    text: `⏰ Reminder: ${msg}`,
    post_at: epoch,
  });
  console.log("scheduled:", resp.scheduled_message_id);
}
/* ----------------------------------- */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
