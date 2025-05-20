import express from "express";
import { WebClient } from "@slack/web-api";
import * as chrono from "chrono-node";      // ← fixed
import morgan from "morgan";

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const app   = express();
app.use(express.json());

app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === "url_verification") return res.json({ challenge });

  if (type === "event_callback" && event.type === "app_mention") {
    try {
      await handleMention(event);
    } catch (err) {
      console.error(err);
    }
  }
  res.sendStatus(200);   // always acknowledge
});

async function handleMention(event) {
  const text = event.text;                             // full message body
  const mentionMatch = text.match(/<@([A-Z0-9]+)>/g);  // all user mentions
  if (!mentionMatch || mentionMatch.length < 2) return; // need bot + someone else
  const userId = mentionMatch[1].replace(/[<>@]/g, ""); // second mention = target

  // strip the two mentions → leave the sentence
  const core = text.replace(/<@([A-Z0-9]+)>/g, "").trim();

  // very naive split: “… remind … at TIME”
  const [, message, timePart] = core.match(/remind\s+(.*)\s+at\s+(.*)/i) || [];
  if (!message || !timePart) return;

  // convert "3 pm", "tomorrow 9", "17:30" → Unix epoch (sec)
  const date = chrono.parseDate(timePart, new Date(), { forwardDate: true });
  if (!date) return;

  const result = await slack.conversations.open({ users: userId });
  const dmChannel = result.channel.id;

  await slack.chat.postMessage({
  channel: channel.id,
  text: "Immediate test DM from the bot",
});

  // Optional confirmation back in original thread
  await slack.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: `👍 Got it! I’ll remind <@${userId}> at ${date.toLocaleTimeString()}.`,
  });
}

app.listen(process.env.PORT || 10000, () =>
  console.log("Listening…"),
);
