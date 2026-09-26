// Spaces, members and bans on the gate (shared/member.mjs explains the model).
//
// Tables (the gate's SQLite):
//   spaces  (space, owner_pub, created_at)                         first come, first served
//   members (space, member_id, nullifier, member_pub, joined_at, banned)
//
// member_id = "member-" + 6 bytes of HMAC(gate secret, space ‖ nullifier). Keyed, so nobody outside
// the gate can compute a member's pseudonym from their nullifier; stable, so a ban sticks.
import { SPACE_RE, MSG, verifySig, sign, memberIdFor as keyedMemberId } from '../shared/member.mjs'
import { httpError } from './core-errors.mjs'

const HEX64 = /^[0-9a-f]{64}$/
const MEMBER_RE = /^member-[0-9a-f]{12}$/

export function createSpaces(db, { secret, signPriv, ensSpaces = null }) {
  db.exec(`CREATE TABLE IF NOT EXISTS spaces (space TEXT PRIMARY KEY, owner_pub TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  db.exec(`CREATE TABLE IF NOT EXISTS members (space TEXT, member_id TEXT, nullifier TEXT NOT NULL, member_pub TEXT,
    joined_at INTEGER NOT NULL, banned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (space, member_id))`)

  const memberIdFor = (space, nullifier) => keyedMemberId(secret, space, nullifier)

  return {
    exists: (space) => !!db.prepare('SELECT 1 FROM spaces WHERE space = ?').get(space),

    /** Register a space to an owner key. The signature proves the caller holds that key. */
    register({ space, ownerPub, sig }) {
      if (!SPACE_RE.test(space ?? '') || space.startsWith('@')) throw httpError(400, 'space names are 3–32 of a-z 0-9 -')
      if (!HEX64.test(ownerPub ?? '')) throw httpError(400, 'bad ownerPub')
      if (!verifySig(ownerPub, MSG.register(space, ownerPub), sig ?? '')) throw httpError(403, 'bad signature')
      const row = db.prepare('SELECT owner_pub FROM spaces WHERE space = ?').get(space)
      if (row && row.owner_pub !== ownerPub) throw httpError(409, 'that space is taken')
      if (!row) db.prepare('INSERT INTO spaces VALUES (?, ?, ?)').run(space, ownerPub, Date.now())
      return { space, owner: ownerPub }
    },

    /** After a valid World ID proof for this space: refuse the banned, otherwise (re)join. */
    admit(space, nullifier, memberPub) {
      const memberId = memberIdFor(space, nullifier)
      const row = db.prepare('SELECT banned FROM members WHERE space = ? AND member_id = ?').get(space, memberId)
      if (row?.banned) return { deny: 'You are banned from this space.', banned: true }
      if (memberPub && !HEX64.test(memberPub)) return { deny: 'bad member key' }
      if (row) {
        if (memberPub) db.prepare('UPDATE members SET member_pub = ? WHERE space = ? AND member_id = ?').run(memberPub, space, memberId)
      } else {
        db.prepare('INSERT INTO members (space, member_id, nullifier, member_pub, joined_at) VALUES (?, ?, ?, ?, ?)')
          .run(space, memberId, nullifier, memberPub ?? null, Date.now())
      }
      return { memberId }
    },

    /** Countersign a post by a member — the gate sees only the content HASH, never the text. */
    async attest({ space, memberId, contentHash, sig }) {
      if (!SPACE_RE.test(space ?? '') || !MEMBER_RE.test(memberId ?? '') || !HEX64.test(contentHash ?? ''))
        throw httpError(400, 'bad request')
      const m = db.prepare('SELECT member_pub, banned FROM members WHERE space = ? AND member_id = ?').get(space, memberId)
      if (!m) return { deny: 'not a member of this space' }
      if (m.banned) return { deny: 'You are banned from this space.' }
      // ENS spaces: the ban list is the space's ENS record, read live.
      if (space.startsWith('@') && (await ensSpaces?.isBanned(space, memberId))) return { deny: 'You are banned from this space.' }
      if (!m.member_pub || !verifySig(m.member_pub, MSG.authorRequest(space, memberId, contentHash), sig ?? ''))
        return { deny: 'not signed by this member' }
      return { sig: sign(signPriv, MSG.attestation(space, memberId, contentHash)) }
    },

    /** Owner bans (or unbans) a member. The ban is on the NULLIFIER behind the pseudonym. */
    ban({ space, memberId, sig, unban = false }) {
      const s = db.prepare('SELECT owner_pub FROM spaces WHERE space = ?').get(space ?? '')
      if (!s) throw httpError(404, 'no such space')
      if (!verifySig(s.owner_pub, MSG.ban(space, memberId, unban), sig ?? '')) throw httpError(403, 'only the space owner can do that')
      const r = db.prepare('UPDATE members SET banned = ? WHERE space = ? AND member_id = ?').run(unban ? 0 : 1, space, memberId)
      if (!r.changes) throw httpError(404, 'no such member')
      return { space, memberId, banned: !unban }
    },

    members: (space) => db.prepare('SELECT member_id, banned, joined_at FROM members WHERE space = ?').all(space),
  }
}
