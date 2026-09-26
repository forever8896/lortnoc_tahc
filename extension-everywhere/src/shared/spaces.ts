// Space keys, kept in this extension's own storage (never in a page):
//   owner keys  — for spaces you created: registering the name and banning members
//   member keys — per space you joined: the key the gate binds your member pseudonym to, and that
//                 signs "post as my member name" requests. Not World ID — joining did that once.
import { genSigner, sign, MSG } from '../../../shared/member.mjs'
import { gatePost } from './messages'

type Signer = { priv: string; pub: string }
type Membership = Signer & { memberId?: string }
const OWNER = 'spaceOwnerKeys'
const MEMBER = 'spaceMemberships'

async function read<T>(key: string): Promise<Record<string, T>> {
  return ((await chrome.storage.local.get(key))[key] as Record<string, T>) ?? {}
}
async function write<T>(key: string, v: Record<string, T>) {
  await chrome.storage.local.set({ [key]: v })
}

export const ownedSpaces = () => read<Signer>(OWNER)
export const memberships = () => read<Membership>(MEMBER)

/** Create a space: a fresh owner key, registered with the gate (first come, first served). */
export async function createSpace(space: string): Promise<void> {
  const owners = await ownedSpaces()
  const key = owners[space] ?? genSigner()
  const r = await gatePost('/space', { space, ownerPub: key.pub, sig: sign(key.priv, MSG.register(space, key.pub)) })
  if (!r?.space) throw new Error(r?.error ?? 'the gate refused')
  owners[space] = key
  await write(OWNER, owners)
}

/** The member key for a space, made on first need (it is sent when you join via World ID). */
export async function memberKey(space: string): Promise<Membership> {
  const all = await memberships()
  if (!all[space]) {
    all[space] = genSigner()
    await write(MEMBER, all)
  }
  return all[space]
}

export async function rememberMember(space: string, memberId: string) {
  const all = await memberships()
  all[space] = { ...(all[space] ?? genSigner()), memberId }
  await write(MEMBER, all)
}

/** Ask the gate to countersign a post's HASH as your member name (it never sees the text). */
export async function attestAsMember(space: string, contentHashHex: string): Promise<{ memberId: string; sig: string }> {
  const m = (await memberships())[space]
  if (!m?.memberId) throw new Error(`You are not a member of ${space} yet — open one of its posts with World ID first.`)
  const r = await gatePost('/member/sign', {
    space, memberId: m.memberId, contentHash: contentHashHex,
    sig: sign(m.priv, MSG.authorRequest(space, m.memberId, contentHashHex)),
  })
  if (!r?.sig) throw new Error(r?.deny ?? r?.error ?? 'the gate would not sign')
  return { memberId: m.memberId, sig: r.sig }
}

export async function banMember(space: string, memberId: string, unban = false) {
  const key = (await ownedSpaces())[space]
  if (!key) throw new Error('Only the space owner can ban.')
  const r = await gatePost('/ban', { space, memberId, unban, sig: sign(key.priv, MSG.ban(space, memberId, unban)) })
  if (r?.banned === undefined) throw new Error(r?.error ?? 'the gate refused')
  return r.banned as boolean
}
