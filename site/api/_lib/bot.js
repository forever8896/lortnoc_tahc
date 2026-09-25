// Lortnoc Tahc onboarding bot — the conversation, kept free of I/O so it can be tested.
//
// `handleUpdate(update, deps)` takes one Telegram update and does everything through `deps`:
//   deps.api(method, params)  → calls the Telegram Bot API
//   deps.store                → { seen(user, source), step(userId, step), forget(userId) }
//   deps.cfg                  → { releaseUrl, repoUrl, siteUrl }
//
// The flow is driven entirely by inline buttons whose callback data names the next step, so the
// bot holds no session state: any button in any old message still works, a restart loses nothing,
// and two taps racing each other cannot put a user in an impossible state.
//
// This is the X extension (extension-x/), NOT the Telegram overlay. Its public mode is
// obfuscation rather than encryption (extension-x/README.md, "Mode 1 is obfuscation"), and the
// copy below says so rather than implying every post is private.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Callback data → step. Unknown data falls back to the start, never to an error. */
export const STEPS = ['welcome', 'download', 'load', 'run', 'raffle', 'done']

/** The accounts a raffle entrant must follow on X. Follows are NOT checked by the bot — that
 *  would need the X API, which §4 rules out — so entrants send their X handle and the team
 *  checks follows when drawing. */
export const FOLLOW = ['kirstenrpomales', 'KilianSolutions', 'LortnocTahc']

/** An X handle: optional @, 1–15 letters, digits or underscores. */
export const X_HANDLE = /^@?([A-Za-z0-9_]{1,15})$/

export function screen(step, cfg) {
  const next = (label, to) => [{ text: label, callback_data: `go:${to}` }]
  const back = (to) => ({ text: '← Back', callback_data: `go:${to}` })

  switch (step) {
    case 'download':
      return {
        text:
          `<b>Step 1 of 3 — Download</b>\n\n` +
          `Get the X extension from GitHub Releases. It is built by public CI from the tagged commit, ` +
          `so the file comes from GitHub, not from us.\n\n` +
          `Download the <code>.zip</code> file.`,
        buttons: [
          [{ text: '⬇️ Open the release', url: cfg.releaseUrl }],
          next("I've downloaded it →", 'load'),
          [back('welcome')],
        ],
      }

    case 'load':
      return {
        text:
          `<b>Step 2 of 3 — Unpack and load</b>\n\n` +
          `1. <b>Unzip</b> it somewhere permanent. Chrome keeps reading from that folder — if it gets deleted, so does the extension.\n` +
          `2. Open <code>chrome://extensions</code> (Brave, Edge and Arc work too).\n` +
          `3. Turn on <b>Developer mode</b>, top-right.\n` +
          `4. Click <b>Load unpacked</b> and pick the unzipped folder.\n` +
          `5. Pin <b>lortnoc tahc for X</b> to your toolbar.\n\n` +
          `Chrome will remind you it's a developer extension on each launch. Expected — that's the price of not going through a store.`,
        buttons: [next("It's loaded →", 'run'), [back('download')]],
      }

    case 'run':
      return {
        text:
          `<b>Step 3 of 3 — Post something</b>\n\n` +
          `1. Open <b>x.com</b> and click the extension icon.\n` +
          `2. Switch it <b>on</b>.\n` +
          `3. Write a post as normal and hit Post. It is swapped for ordinary-looking text before it leaves the page, tagged <code>#lortnoctahc</code>.\n` +
          `4. Anyone with the extension sees it decode back inline.\n\n` +
          `<b>Two modes — know which you're in:</b>\n` +
          `• <b>Recipients empty</b> → public channel. Everyone with the extension can read it. It hides your post from people who don't have the tool; it is <b>not</b> private.\n` +
          `• <b>Recipients set</b> (their <code>name.lortnoctahc.eth</code> handles) → only those people can read it.\n\n` +
          `Longer messages become a short thread. That's normal.`,
        buttons: [next('Done — enter the raffle →', 'raffle'), [back('load')]],
      }

    case 'raffle':
      return {
        text:
          `<b>ETHGlobal Tokyo raffle</b>\n\n` +
          `To enter, follow all three on X:\n` +
          FOLLOW.map((h) => `• <a href="https://x.com/${h}">@${h}</a>`).join('\n') +
          `\n\nThen <b>reply here with your X handle</b> (e.g. <code>@yourname</code>). ` +
          `We check the follows when we draw, so make sure it's the account that follows them.`,
        buttons: [
          ...FOLLOW.map((h) => [{ text: `Follow @${h}`, url: `https://x.com/${h}` }]),
          [back('run')],
        ],
      }

    case 'done':
      return {
        text:
          `<b>You're entered — good luck in Tokyo.</b>\n\n` +
          `Stuck, or something broke? Reply here — a human reads this.\n\n` +
          `/steps — walk through setup again\n/privacy — what this bot keeps about you\n/delete — erase it`,
        buttons: [[{ text: 'lortnoctahc.com', url: cfg.siteUrl }]],
      }

    case 'welcome':
    default:
      return {
        text:
          `<b>Lortnoc Tahc for X</b> — hide what you post inside what you post.\n\n` +
          `You write a real post. Before it leaves the page, the extension turns it into ordinary-looking text. ` +
          `People with the extension see the real one; everyone else sees chatter.\n\n` +
          `Setup takes about five minutes: download, load, post — then enter the <b>ETHGlobal Tokyo raffle</b>.\n\n` +
          `<i>This bot keeps your Telegram username so we can reach alpha testers. /privacy for details, /delete to erase it.</i>`,
        buttons: [next("Let's set it up →", 'download')],
      }
  }
}

const PRIVACY =
  `<b>What this bot keeps</b>\n\n` +
  `Your Telegram user ID and username, your X handle if you entered the raffle, when you first started it, how far through setup you got, and where you came from (e.g. the website). Nothing else — not your messages, not your contacts.\n\n` +
  `It's used only to contact alpha testers and run the raffle. /delete removes it immediately.`

const keyboard = (buttons) => ({ inline_keyboard: buttons })

/** Handle one update. Returns nothing; all effects go through deps. */
export async function handleUpdate(update, { api, store, cfg }) {
  // ── button taps ────────────────────────────────────────────────────────────────────────
  if (update.callback_query) {
    const q = update.callback_query
    const data = String(q.data || '')
    const step = data.startsWith('go:') && STEPS.includes(data.slice(3)) ? data.slice(3) : 'welcome'
    await store.seen(q.from, null)
    await store.step(q.from.id, step)
    const s = screen(step, cfg)
    await api('answerCallbackQuery', { callback_query_id: q.id })
    // Edit in place so the chat reads as one card walking forward, not a scroll of repeats.
    // Fall back to a new message if the old one can't be edited (too old, or deleted).
    if (q.message) {
      const edited = await api('editMessageText', {
        chat_id: q.message.chat.id,
        message_id: q.message.message_id,
        text: s.text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: keyboard(s.buttons),
      })
      if (edited?.ok !== false) return
    }
    await api('sendMessage', {
      chat_id: q.from.id, text: s.text, parse_mode: 'HTML',
      disable_web_page_preview: true, reply_markup: keyboard(s.buttons),
    })
    return
  }

  // ── messages ───────────────────────────────────────────────────────────────────────────
  const m = update.message
  if (!m || !m.from || m.from.is_bot) return
  // Groups: this is a 1:1 onboarding bot. Stay quiet rather than collecting a room's handles.
  if (m.chat?.type !== 'private') return

  const text = String(m.text || '').trim()
  const [cmd, ...rest] = text.split(/\s+/)
  const command = cmd.startsWith('/') ? cmd.slice(1).split('@')[0].toLowerCase() : null
  const send = (t, buttons) => api('sendMessage', {
    chat_id: m.chat.id, text: t, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(buttons ? { reply_markup: keyboard(buttons) } : {}),
  })

  if (command === 'delete') {
    await store.forget(m.from.id)
    return send(`Done — everything this bot held about you is deleted. /start brings you back.`)
  }
  if (command === 'privacy') return send(PRIVACY)

  // `/start site` arrives as a deep link from lortnoctahc.com/onboarding; the payload is a source
  // tag, sanitised hard because it is user-controlled text headed for the database.
  const source = command === 'start' && rest[0] ? rest[0].replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || null : null
  await store.seen(m.from, source)

  if (command === 'start' || command === 'steps') {
    await store.step(m.from.id, 'welcome')
    const s = screen('welcome', cfg)
    return send(s.text, s.buttons)
  }
  if (command === 'help') {
    const s = screen('done', cfg)
    return send(`Reply here with what went wrong and a human will get back to you.\n\n/steps — setup from the top\n/privacy — what's kept\n/delete — erase it`, s.buttons)
  }

  // On the raffle step, a message that looks like an X handle IS the entry.
  if (text && !command) {
    const h = text.match(X_HANDLE)
    if (h && (await store.stepOf?.(m.from.id)) === 'raffle') {
      await store.enter(m.from.id, h[1])
      await store.step(m.from.id, 'done')
      const s = screen('done', cfg)
      return send(`Entered as <b>@${esc(h[1])}</b>.\n\n` + s.text, s.buttons)
    }
  }

  // Anything else is a person asking for help. Acknowledge it; the admin view shows the user.
  if (text && !command) {
    await store.note?.(m.from.id, text.slice(0, 1000))
    return send(`Got it — someone will reply here. Meanwhile, /steps walks through setup again.`)
  }
  return send(`Try /steps to walk through setup, or just tell me what's wrong.`)
}

export { esc }
