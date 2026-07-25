/// ConversationHead — the mutable Sui pointer for a conversation (§5.4, §6.4).
/// Holds the ordered list of Walrus blob ids (each an encrypted message batch) plus the
/// addresses allowed to read it. Single-writer for the demo (no multi-writer ordering).
///
/// The `seal_approve` at the bottom is the access policy Seal's key servers dry-run before
/// releasing a decryption key share: no share unless the caller is a participant in THIS
/// conversation. That is what makes Seal an access-control layer here rather than a plain
/// encrypt-library (§6.4, "condition of keeping Seal").
module lortnoc::conversation;

use std::string::String;

/// The caller is not a participant, or the identity is not namespaced to this object.
const ENoAccess: u64 = 0;
/// Only a participant may append to the log.
const ENotParticipant: u64 = 1;

/// The conversation head — a shared object so both participants can read and append.
public struct ConversationHead has key, store {
    id: UID,
    /// Participant handles, for display (`alice.lortnoctahc.eth`).
    a: String,
    b: String,
    /// Participant addresses — what access control actually keys on.
    members: vector<address>,
    /// Walrus blob ids, in order. Each blob is encrypted client-side.
    blobs: vector<String>,
    seq: u64,
    updated_at: u64,
}

public struct ConversationCreated has copy, drop {
    head: address,
    a: String,
    b: String,
}

/// Create a conversation head with the first message blob. The sender is a member; `peer` is
/// the counterparty's address (resolved from their ENS record app-side).
public fun create(
    a: String,
    b: String,
    peer: address,
    blob: String,
    ts: u64,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    let mut members = vector[sender];
    // A self-chat would otherwise list the same address twice and break the membership check.
    if (peer != sender) members.push_back(peer);

    let head = ConversationHead {
        id: object::new(ctx),
        a,
        b,
        members,
        blobs: vector[blob],
        seq: 1,
        updated_at: ts,
    };
    sui::event::emit(ConversationCreated { head: head.id.to_address(), a: head.a, b: head.b });
    transfer::share_object(head);
}

/// Append a message blob id + bump seq. Participants only — the head is a shared object, so
/// without this check anyone on the network could write into someone else's conversation.
public fun append(head: &mut ConversationHead, blob: String, ts: u64, ctx: &TxContext) {
    assert!(head.members.contains(&ctx.sender()), ENotParticipant);
    head.blobs.push_back(blob);
    head.seq = head.seq + 1;
    head.updated_at = ts;
}

// ── Views ───────────────────────────────────────────────────────────────────

public fun blobs(head: &ConversationHead): &vector<String> { &head.blobs }

public fun seq(head: &ConversationHead): u64 { head.seq }

public fun is_member(head: &ConversationHead, who: address): bool {
    head.members.contains(&who)
}

// ── Seal access-control policy (§6.4) ───────────────────────────────────────
//
// Seal key servers call this via `dry_run`: if it aborts, no key share is issued. Two
// conditions, both required:
//   1. the identity being decrypted is namespaced to THIS head object — otherwise a member of
//      one conversation could request key shares for another;
//   2. the caller is a participant.
//
// Roadmap (§6.4/§7): swap condition 2 for a set-membership check against a shared nullifier
// registry, so access is a bearer capability rather than an address. Never verify a ZK proof
// in here — verify at registration time and check membership cheaply.
entry fun seal_approve(id: vector<u8>, head: &ConversationHead, ctx: &TxContext) {
    assert!(is_prefix(head.id.to_address().to_bytes(), id), ENoAccess);
    assert!(head.members.contains(&ctx.sender()), ENoAccess);
}

/// Is `prefix` a prefix of `word`?
fun is_prefix(prefix: vector<u8>, word: vector<u8>): bool {
    if (prefix.length() > word.length()) return false;
    let mut i = 0;
    while (i < prefix.length()) {
        if (prefix[i] != word[i]) return false;
        i = i + 1;
    };
    true
}
