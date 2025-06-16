/*
Project Structure:

index.js                   # Main Express app bootstrapping Slack bot, slash commands & doc endpoint
services/
  slackClient.js          # Exports configured Slack WebClient
  reminderStore.js        # In-memory reminder store (add, list, due, delete)
  scheduler.js            # Cron scheduler to fire due reminders
  docGen.js               # Stub for docx generation endpoint

Required dependencies (package.json):
{
  "type": "module",
  "dependencies": {
    "@slack/web-api": "^7.3.0",
    "chrono-node": "^2.7.8",
    "moment-timezone": "^0.5.43",
    "express": "^4.19.0",
    "morgan": "^1.10.0",
    "node-cron": "^3.0.0",
    "docx": "^7.3.0"
  },
  "scripts": { "start": "node index.js" }
}
*/

// index.js
import express from 'express';
import morgan from 'morgan';
import { handleMention, handleMessage } from './handlers/slackEvents.js';
import { slack } from './services/slackClient.js';
import { addReminder, listReminders, deleteReminder } from './services/reminderStore.js';
import './services/scheduler.js';
import docRoutes from './handlers/docRoutes.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('tiny'));

// Health-check
app.get('/slack/webhook', (_req, res) => res.send('Bot running.'));

// Event callback endpoint
app.post('/slack/webhook', async (req, res) => {
  const { type, challenge, event } = req.body;
  if (type === 'url_verification') return res.json({ challenge });

  if (type === 'event_callback') {
    if (event.type === 'app_mention') {
      handleMention(event).catch(console.error);
    }
    else if (event.type === 'message' && !event.bot_id) {
      handleMessage(event).catch(console.error);
    }
  }
  res.sendStatus(200);
});

// Slash commands for /reminder
app.post('/slack/commands', async (req, res) => {
  const { text, user_id, channel_id } = req.body;
  const [action, timespec, ...msg] = text.trim().split(' ');
  const task = msg.join(' ');

  if (action === 'set') {
    // parse timespec relative via chrono
    const when = require('chrono-node').parseDate(timespec, new Date(), { forwardDate: true }).getTime();
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

// Doc‑generation endpoint
app.use('/api', docRoutes);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));


/*--------------------------------------------------*/
// services/slackClient.js
import { WebClient } from '@slack/web-api';
export const slack = new WebClient(process.env.SLACK_BOT_TOKEN);


/*--------------------------------------------------*/
// services/reminderStore.js
const store = new Map();
import { v4 as uuid } from 'uuid';

export async function addReminder({ user, task, time, channel }) {
  const id = uuid();
  store.set(id, { id, user, task, time, channel });
  return id;
}

export async function listReminders(user) {
  return Array.from(store.values()).filter(r => r.user === user);
}

export async function getDueReminders() {
  const now = Date.now();
  return Array.from(store.values()).filter(r => r.time <= now);
}

export async function deleteReminder(id) {
  store.delete(id);
}


/*--------------------------------------------------*/
// services/scheduler.js
import cron from 'node-cron';
import { getDueReminders, deleteReminder } from './reminderStore.js';
import { slack } from './slackClient.js';

cron.schedule('* * * * *', async () => {
  const due = await getDueReminders();
  for (const r of due) {
    try {
      const { channel } = await slack.conversations.open({ users: r.user });
      await slack.chat.postMessage({ channel: channel.id, text: `⏰ Reminder: ${r.task}` });
      // also post back to original channel if desired
      await slack.chat.postMessage({ channel: r.channel, text: `⏰ Reminder for <@${r.user}>: ${r.task}` });
    } catch (e) {
      console.error('Reminder error:', e);
    }
    await deleteReminder(r.id);
  }
});


/*--------------------------------------------------*/
// handlers/slackEvents.js
import chrono from 'chrono-node';
import moment from 'moment-timezone';
import { slack } from '../services/slackClient.js';
import { addReminder } from '../services/reminderStore.js';

export async function handleMention(event) {
  const botId = event.authorizations?.[0]?.user_id;
  let text = event.text.replace(`<@${botId}>`, '').trim();
  // pattern: "I will do it at 9:30 pm"
  const m = text.match(/at (.+)$/i);
  if (!m) return;

  const timeRaw = m[1];
  const tz = 'America/Moncton';
  const now = moment().tz(tz);
  const parsed = chrono.parseDate(timeRaw, now.toDate(), { forwardDate: true });
  const schedule = moment(parsed).tz(tz);
  const delaySec = schedule.unix() - now.unix();
  if (delaySec < 60) return;

  await slack.chat.postMessage({ channel: event.channel, thread_ts: event.ts, text: 'I will do it.' });
  await addReminder({ user: event.user, task: `Via mention: ${text}`, time: schedule.valueOf(), channel: event.channel });
}

export async function handleMessage(event) {
  const text = (event.text || '').toLowerCase();
  const keywords = ['#followup', '#urgent'];
  if (keywords.some(kw => text.includes(kw))) {
    await slack.chat.postMessage({ channel: event.channel, text: '🔔 Noted—reminding in 1h.' });
    const when = Date.now() + 3600000;
    await addReminder({ user: event.user, task: text, time: when, channel: event.channel });
  }
}


/*--------------------------------------------------*/
// handlers/docRoutes.js
import express from 'express';
import { generateTimesheet } from '../services/docGen.js';
const router = express.Router();

router.post('/generate-doc', async (req, res) => {
  try {
    const buffer = await generateTimesheet(req.body);
    res
      .status(200)
      .set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="timesheet.docx"'
      })
      .send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error generating document');
  }
});

export default router;


/*--------------------------------------------------*/
// services/docGen.js
import { Document, Packer, Paragraph } from 'docx';

export async function generateTimesheet(data) {
  // Basic stub: create a document with a title; extend with table templating as needed.
  const doc = new Document({ sections: [{ children: [ new Paragraph('Timesheet') ] }] });
  const buffer = await Packer.toBuffer(doc);
  return buffer;
}
