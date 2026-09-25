#!/usr/bin/env node
// One-time (idempotent) setup for the onboarding bot: point Telegram at the webhook, set the
// command menu and the text shown before someone presses Start.
//
//   TG_BOT_TOKEN=... TG_WEBHOOK_SECRET=... node site/scripts/tgbot-setup.mjs
//
// Use the SAME TG_WEBHOOK_SECRET that is set in Vercel, or every update is rejected with 401.
const token = process.env.TG_BOT_TOKEN
const secret = process.env.TG_WEBHOOK_SECRET
const url = process.env.TG_WEBHOOK_URL || 'https://www.lortnoctahc.com/api/tgbot'
if (!token || !secret) {
  console.error('set TG_BOT_TOKEN and TG_WEBHOOK_SECRET')
  process.exit(1)
}

async function call(method, params) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  })
  const body = await r.json()
  console.log(`${method.padEnd(24)} ${body.ok ? 'ok' : `FAILED: ${body.description}`}`)
  if (!body.ok) process.exit(1)
  return body.result
}

const me = await call('getMe', {})
await call('setWebhook', {
  url,
  secret_token: secret,
  // Only what the bot handles. Fewer update types = fewer requests that can go wrong.
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
})
await call('setMyCommands', {
  commands: [
    { command: 'start', description: 'Set up Lortnoc Tahc for X' },
    { command: 'steps', description: 'Walk through setup again' },
    { command: 'help', description: 'Something went wrong' },
    { command: 'privacy', description: 'What this bot keeps about you' },
    { command: 'delete', description: 'Erase what this bot keeps' },
  ],
})
await call('setMyShortDescription', { short_description: 'Hide what you post inside what you post. Setup for the X extension.' })
await call('setMyDescription', {
  description:
    'Lortnoc Tahc for X turns your real posts into ordinary-looking text before they leave the page. ' +
    'This bot walks you through downloading, verifying and loading the extension — about five minutes.',
})
const info = await call('getWebhookInfo', {})
console.log(`\nbot        @${me.username}`)
console.log(`webhook    ${info.url}  (pending updates: ${info.pending_update_count})`)
console.log(`deep link  https://t.me/${me.username}?start=site   <- point lortnoctahc.com/onboarding here`)
