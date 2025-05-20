/**
 * Slack Reminder Bot — DM version
 * -------------------------------
 * ➊ package.json  must contain:
 *    {
 *      "type": "module",
 *      "dependencies": {
 *        "@slack/web-api": "^7.3.0",
 *        "chrono-node": "^2.7.8",
 *        "express": "^4.19.0",
 *        "morgan": "^1.10.0"
 *      }
 *    }
 * ➋ Environment variable (Render ▸ Environment ▸ Variables):
 *    SLACK_BOT_TOKEN = xoxb-…
 * ➌ Required bot-token scopes:
 *    chat:write, im:read, im:write, users:read,
 *    channels:read, channels:history
 */

import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();

app.use(express.json());
app.use(morgan("tiny"));               // request logging for Render

/* simple GET so you/Render can hit the endpoint */
app.get("/slack/webhook", (_, res) =>
  res.send("Slack Reminder Bot up — send POSTs only.")
);

app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  if (type === "url_verification") return res.json({ challenge });

  if (type === "event_callback" && event?.type === "app_mention") {
    handleMention(event).catch(err =>
      console.error("handleMention error:", err)
    );
  }
  res.sendStatus(200);   // always acknowledge
});

/* -------- core logic ---------------------------------------------------- */
async function handleMention(event) {
  const botId = event.authorizations?.[0]?.user_id;
  const mentionRE = /<@([A-Z0-9]+)>/g;

  // strip out only the bot's own mention
  const cleaned = event.text.replace(mentionRE, (m, id) => (id === botId ? "" : m)).trim();

  // if "me" is present, target = sender
  let targetUser = event.user;
  const explicit = cleaned.match(mentionRE);
  if (explicit && explicit.length) {
    targetUser = explicit[0].replace(/[<@>]/g, "");
  }

  // bail if target is a bot
  const { user } = await slack.users.info({ user: targetUser });
  if (user.is_bot) return;

  // parse "remind ... at ..."
  const [, msg, when] = cleaned.match(/remind\s+(.*)\s+at\s+(.*)/i) || [];
  if (!msg || !when) return;

  const date = chrono.parseDate(when, new Date(), { forwardDate: true });
  if (!date) return;

  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  await slack.chat.postMessage({
    channel: dm.id,
    text: `👍 Got it! I’ll remind you at ${date.toLocaleTimeString()}.`,
  });

  await slack.chat.scheduleMessage({
    channel: dm.id,
    text: `⏰ Reminder: ${msg}`,
    post_at: Math.floor(date.getTime() / 1000),
  });
}
/* ----------------------------------------------------------------------- */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
