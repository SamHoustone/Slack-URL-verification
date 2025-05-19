import express from "express";
const app = express();
app.use(express.json());          // Parse JSON bodies

app.post("/slack/webhook", (req, res) => {
  const { type, challenge } = req.body;
  if (type === "url_verification" && challenge) {
    return res.json({ challenge });   // <-- the magic 1-liner
  }
  return res.sendStatus(400);         // anything else = bad request
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
