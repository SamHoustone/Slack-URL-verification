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
  const botId = event.authorizations?.[0]?.user_id;          // id of your bot
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  const mentions = [...event.text.matchAll(mentionRegex)].map(m => m[1]);

  /* If the user typed “remind me …” treat the sender as the target   */
  let targetUser = event.user;                               // default
  if (mentions.length > 1) {
    // second mention (first is bot)
    const second = mentions.find(id => id !== botId);
    if (second) targetUser = second;
  }

  /* Strip all mentions from the text, leaving “remind … at …” */
  const core = event.text.replace(mentionRegex, "").trim();
  const [, message, timePart] =
    core.match(/remind\s+(.*)\s+at\s+(.*)/i) || [];
  if (!message || !timePart) return;                         // nothing to do

  /* Parse natural-language time; make sure it’s in the future */
  const date = chrono.parseDate(timePart, new Date(), { forwardDate: true });
  if (!date) return;
  const epoch = Math.floor(date.getTime() / 1000);

  /* Open DM with the target user */
  const { channel: dm } = await slack.conversations.open({ users: targetUser });

  console.log("Scheduling reminder", {
    targetUser,
    dmChannel: dm.id,
    post_at: date.toISOString(),
    text: message,
  });

  /* Send immediate confirmation in DM */
  await slack.chat.postMessage({
    channel: dm.id,
    text: `👍 Got it! I’ll remind you at ${date.toLocaleTimeString()}.`,
  });

  /* Schedule the actual reminder */
  const resp = await slack.chat.scheduleMessage({
    channel: dm.id,
    text: `⏰ Reminder: ${message}`,
    post_at: epoch,
  });

  console.log("scheduleMessage response", resp);
}
/* ----------------------------------------------------------------------- */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Listening on", PORT));
