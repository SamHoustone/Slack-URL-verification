import express from "express";
const app = express();
app.use(express.json());

app.post("/slack/webhook", (req, res) => {
  const { type, challenge, event } = req.body;

  // 1) URL-verification handshake
  if (type === "url_verification") {
    return res.json({ challenge });      // 200 OK
  }

  // 2) Every real Slack event lands here
  if (type === "event_callback") {
    console.log("⚡️  event:", event);    // <- shows in Render logs
    return res.sendStatus(200);          // MUST be 2xx or Slack will retry/disable
  }

  // 3) Anything else → still 200 (or 204) so Slack stays happy
  return res.sendStatus(200);
});
import { WebClient } from "@slack/web-api";
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// inside the POST handler, after you detect an app_mention event
await slack.chat.postMessage({
  channel: event.channel,
  thread_ts: event.ts,
  text: "👋 Hello, world! I received your mention.",
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
