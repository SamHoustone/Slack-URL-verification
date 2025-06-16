/*
Unified index.js for Slack Reminder + Doc-Generation Bot
Run with: node index.js
Requirements in package.json:
{
  "type": "module",
  "scripts": { "start": "node index.js" },
  "dependencies": {
    "@slack/web-api": "^7.3.0",
    "chrono-node": "^2.7.8",
    "moment-timezone": "^0.5.43",
    "express": "^4.19.0",
    "morgan": "^1.10.0",
    "node-cron": "^3.0.0",
    "uuid": "^9.0.0",
    "docx": "^7.3.0"
  }
}
--------------------------------------
*/

import express from 'express';
import morgan from 'morgan';
import { WebClient } from '@slack/web-api';
import chrono from 'chrono-node';
import moment from 'moment-timezone';
import cron from 'node-cron';
import { v4 as uuid } from 'uuid';
import { Document, Packer, Paragraph } from 'docx';

// --- Slack setup ---
const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// --- In-memory reminder store ---
const store = new Map();
async function addReminder({ user, task, time, channel }) {
  const id = uuid(); store.set(id, { id, user, task, time, channel });
  return id;
}
async function listReminders(user) {
  return Array.from(store.values()).filter(r => r.user === user);
}
async function getDueReminders() {
  const now = Date.now();
  return Array.from(store.values()).filter(r => r.time <= now);
}
async function deleteReminder(id) {
  store.delete(id);
}

// --- Scheduler: runs every minute ---
cron.schedule('* * * * *', async () => {
  const due = await getDueReminders();
  for (const r of due) {
    try {
      const { channel } = await slack.conversations.open({ users: r.user });
      await slack.chat.postMessage({ channel: channel.id, text: `⏰ Reminder: ${r.task}` });
      // optional: post back to original channel
      await slack.chat.postMessage({ channel: r.channel, text: `⏰ Reminder for <@${r.user}>: ${r.task}` });
    } catch (e) {
      console.error('Reminder error:', e);
    }
    await deleteReminder(r.id);
  }
});

// --- Express app setup ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

// Health check
app.get('/', (_req, res) => res.send('Bot is up'));

// Slack Events endpoint
app.post('/slack/webhook', async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === 'url_verification') return res.json({ challenge });
  if (type === 'event_callback') {
    if (event.type === 'app_mention') handleMention(event).catch(console.error);
    else if (event.type === 'message' && !event.bot_id) handleMessage(event).catch(console.error);
  }
  res.sendStatus(200);
});

// Slash commands
app.post('/slack/commands', async (req, res) => {
  const { text, user_id, channel_id } = req.body;
  const [action, timespec, ...msg] = text.trim().split(' ');
  const task = msg.join(' ');
  if (action === 'set') {
    const when = chrono.parseDate(timespec, new Date(), { forwardDate: true }).getTime();
    await addReminder({ user: user_id, task, time: when, channel: channel_id });
    return res.send(`✅ Reminder set for ${timespec}: “${task}”`);
  }
  if (action === 'list') {
    const list = await listReminders(user_id);
    return res.send(
      list.length
        ? list.map(r => `• [${r.id}] ${r.task} at ${new Date(r.time).toLocaleString()}`).join('\n')
        : 'No upcoming reminders.'
    );
  }
  if (action === 'delete') {
    await deleteReminder(timespec);
    return res.send(`🗑️ Deleted reminder ${timespec}.`);
  }
  res.send('Usage: `/reminder set|list|delete <time> [message]`');
});

// Doc-generation endpoint
app.post('/api/generate-doc', async (req, res) => {
  try {
    const data = req.body;
    // Simple doc: replace with docxtpl logic as needed
    const doc = new Document({ sections: [{ children: [ new Paragraph('Timesheet') ] }] });
    const buffer = await Packer.toBuffer(doc);
    res
      .status(200)
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="timesheet.docx"'
      })
      .send(buffer);
  } catch (err) {
    console.error('DocGen error:', err);
    res.status(500).send('Error generating document');
  }
});

// --- Mention handler ---
async function handleMention(event) {
  const botId = event.authorizations?.[0]?.user_id;
  let text = event.text.replace(`<@${botId}>`, '').trim();
  const m = text.match(/at (.+)$/i);
  if (!m) return;
  const timeRaw = m[1];
  const tz = 'America/Moncton';
  const now = moment().tz(tz);
  const parsed = chrono.parseDate(timeRaw, now.toDate(), { forwardDate: true });
  if (!parsed) return;
  const schedule = moment(parsed).tz(tz);
  const delaySec = schedule.unix() - now.unix();
  if (delaySec < 60) return;
  await slack.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: 'I will do it.' });
  await addReminder({ user: event.user, task: `Via mention: ${text}`, time: schedule.valueOf(), channel: event.channel });
}

// --- Keyword watcher ---
async function handleMessage(event) {
  const text = (event.text || '').toLowerCase();
  const keywords = ['#followup', '#urgent'];
  if (keywords.some(kw => text.includes(kw))) {
    await slack.chat.postMessage({ channel: event.channel, text: '🔔 Got it—reminding in 1h.' });
    const when = Date.now() + 3600000;
    await addReminder({ user: event.user, task: text, time: when, channel: event.channel });
  }
}

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
