import express from "express";
import { WebClient } from "@slack/web-api";
import morgan from "morgan";          // optional pretty logs

// --- config -------------------------------------------------
const PORT = process.env.PORT || 10000;
const slack = new WebClient(process.env.SLACK_BOT_TOKEN); // must be set in Render → Env
// -----------------------------------------------------------

const app = express();
app.use(express.json());
app.use(morgan("tiny"));              // logs each request line

// health-check for browsers
app.get("/slack/webhook", (_, res) =>
  res.send("Slack webhook up — POST only.")
);

app.post("/slack/webhook", async (req, res) => {
  const { type, challenge, event } = req.body;

  // 1) Slack URL-verification handshake
  if (type === "url_verification") {
    return res.json({ challenge });          // 200 OK
  }

  // 2) Normal events arrive here
  if (type === "event_callback") {
    console.log("⚡️  event:", event);        // view in Render logs

    // sample echo: reply only to app_mentions
    if (event.type === "app_mention") {
      await slack.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,                 // reply in thread
        text: "👋 Hello, world! I received your mention.",
      });
    }
    return res.sendStatus(200);              // ALWAYS 2xx
  }

  // 3) Fallback
  res.sendStatus(200);
});

// start server
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
