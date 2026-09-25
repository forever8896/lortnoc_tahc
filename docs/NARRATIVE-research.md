# Narrative research — women's rights and safe spaces under censorship (2026-09-25)

Working doc for the Tokyo pitch. Facts are cited; the "what it means for us" parts are our judgement.

## 1. The state of things

**Internet freedom is falling, and speech is being prosecuted.** Freedom on the Net 2025 recorded the 15th year of
decline in a row. In a record 57 of the 72 countries it covers, people were arrested for what they posted.
[Freedom House](https://freedomhouse.org/article/new-report-persistent-authoritarian-repression-and-backsliding-democracies-drive-15th)

**Women censor themselves online.**
- 41% of women surveyed limit what they post to avoid abuse.
- Among women journalists, self-censorship rose from 30% (2020) to 45% (2025).
[Freedom on the Net 2025 PDF](https://freedomhouse.org/sites/default/files/2025-11/Freedom_on_the_Net_2025_Digital.pdf)
- Seven in ten women human rights defenders, activists and journalists report online violence.
- Close to one in four have faced AI-assisted abuse (deepfakes).
- 42% say online violence has moved into offline harm.
[UN Women, Dec 2025](https://www.unwomen.org/en/news-stories/press-release/2025/12/seven-in-ten-women-human-rights-defenders-activists-and-journalists-report-online-violence)

**Saudi Arabia — prison for posting.**
- Salma al-Shehab, a Leeds PhD student, got 34 years (later cut) for tweets and retweets supporting women's rights.
  She was released in Feb 2025 after four years.
  [Amnesty](https://www.amnesty.org/en/latest/news/2025/02/saudi-woman-imprisoned-for-tweeting-in-support-of-womens-rights-released-after-four-year-ordeal/)
- Manahel al-Otaibi was sentenced to 11 years for tweets and a Snapchat photo without an abaya. This was cut to
  5 years plus a travel ban in Aug 2025.
  [Amnesty](https://www.amnesty.org/en/documents/mde23/0223/2025/en/)

**Iran — surveillance aimed at women.**
- A UN fact-finding report (Mar 2025) documents drones, facial recognition and the citizen-reporting **Nazer**
  app, used to enforce hijab rules.
  [CNN](https://edition.cnn.com/2025/03/14/middleeast/iran-nazer-app-un-report-intl-latam)
- Iran had its longest recorded internet blackout in 2026. It was partially lifted in late May, with Signal,
  Telegram, X and others still blocked.
- Instagram posts about women in protests have been followed by calls and summonses from security agencies.
- Arrests of women activists continue into mid-2026.
[WNCRI](https://wncri.org/2026/06/04/arrest-women-protests/) · [IranWire](https://iranwire.com/en/features/147306-iran-warns-activists-online-businesses-against-posting-protest-content/)

**Afghanistan — the ban on girls' education reached the internet.**
- Girls are banned from secondary and higher education, so women moved to online classes over WhatsApp and
  similar apps, using aliases.
- In Sept 2025 the Taliban shut the internet down nationwide "to prevent immoral activities".
- One online university class went from 18 women attending to a fraction.
[HRW](https://www.hrw.org/news/2025/09/30/talibans-internet-ban-further-silences-afghan-women-girls) · [UN Women](https://www.unwomen.org/en/news-stories/news/2025/10/when-the-taliban-shut-down-the-internet-women-lost-their-lifeline-to-aid-education-and-each-other)

**Democracies too.**
- In Nebraska, Facebook Messenger chats between a mother and daughter, handed over under warrant, were key
  evidence in an abortion prosecution.
  [19th News](https://19thnews.org/2023/07/abortion-laws-facebook-messages-digital-privacy/)
- EU Chat Control: voluntary scanning ("1.0") was revived until April 2028. The permanent regulation's trilogue
  collapsed in June 2026 and is expected to resume around Sept 2026 under the Irish presidency.
  [The Register](https://www.theregister.com/security/2026/07/09/meps-fail-to-prevent-chat-control-snoopfest-revival/5269379) · [EU Perspectives](https://euperspectives.eu/2026/07/eu-countries-approve-temporary-chat-control-1-0/)

**Threats at home.** Kaspersky found over 31,000 stalkerware cases in 2023, mostly used to watch an intimate
partner. 15% of people surveyed had been made to install a monitoring app by their partner.
[Securelist](https://securelist.com/state-of-stalkerware-2023/112135/)

## 2. The pitch this supports

**"Safe spaces in public places."** The problem is not only secrecy. Women are being pushed out of public spaces
online, through prosecution, surveillance, abuse and brigading, and then out of the internet altogether.
Lortnoc Tahc lets a group meet *inside* an ordinary public page: the comments under a recipe, a reply thread on X.
To everyone else it reads as chatter. The author decides who can read it:
- a circle that knows a passphrase
- named people
- only verified humans, which keeps out bot brigades
- any combination of these

## 3. Where it helps, and where it doesn't — say this on stage

The CLAUDE.md §4 honesty rule applies with extra force here. **Overclaiming to people at risk is the one thing
this pitch cannot do.**

| Situation | Does it help? |
|---|---|
| Keyword scanning, automated moderation, casual reading of public posts | **Yes.** Cover text passes as normal speech |
| Brigading and harassment in a community space | **Yes.** Checks decide who can read. A human-only check stops bot swarms |
| Platform handing over data (the Nebraska pattern) | **Partly.** The platform only holds cover text. The key is never there |
| Internet shutdown (Afghanistan 2025, Iran 2026) | **No.** No network, no tool. Say so |
| Phone or laptop seized at a checkpoint, or a partner with device access | **No, and it can make things worse.** An installed extension is evidence. Decoded text on screen is readable |
| A state targeting users of the tool | **Our `#lortnoctahc` marker is a search query that lists every user.** For high-risk users this must be off |

## 4. Product implications (feed into the PRD)

1. **High-risk mode:**
   - no hashtag marker (the reader uses right-click Reveal only)
   - no ENS handle
   - no decoded history saved
   - one-tap hide
   - warn clearly about device seizure
   The marker exists for convenience on X. It is the wrong default where posting is a crime.
2. **World ID stays a reader check an author may choose, never something a writer must have.** Asking at-risk
   women for a biometric-backed ID to *speak* would reverse the whole point. Its use is keeping bots out of a
   circle.
3. **The gate learns who unlocks what** (nullifiers per post). A high-risk circle should use passphrase or
   recipient checks, which need no server.
4. **Before marketing to at-risk users, have the threat model reviewed** by people who do this work, e.g. the
   Access Now Digital Security Helpline or EFF's Surveillance Self-Defense. Frame the hackathon version as a
   prototype, not a safety tool.

## 5. One-line versions
- "Where speaking is a crime, a comment about salt can be a meeting."
- "Women are self-censoring at record rates. We give them a room inside the public square that only their circle
  can enter."
- Honest close: "It hides what you say, not that you're online — and it's a prototype, not a bulletproof vest."
