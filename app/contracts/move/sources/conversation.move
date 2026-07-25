/// ConversationHead — the mutable Sui pointer for a conversation (§5.4, §6.4).
/// Holds the ordered list of Walrus blob ids (each an encrypted message batch).
/// Single-writer for the demo (no multi-writer ordering).
module lortnoc::conversation {
    use std::string::String;
    use sui::object::{Self, UID};
    use sui::tx_context::TxContext;
    use sui::transfer;

    /// The conversation head — a shared object so both participants can read it.
    public struct ConversationHead has key, store {
        id: UID,
        a: String,        // participant handle
        b: String,        // participant handle
        blobs: vector<String>, // Walrus blob ids, in order
        seq: u64,
        updated_at: u64,
    }

    /// Create a new conversation head with the first message blob.
    public entry fun create(a: String, b: String, blob: String, ts: u64, ctx: &mut TxContext) {
        let mut head = ConversationHead {
            id: object::new(ctx),
            a, b,
            blobs: vector::empty<String>(),
            seq: 0,
            updated_at: ts,
        };
        vector::push_back(&mut head.blobs, blob);
        head.seq = 1;
        transfer::share_object(head);
    }

    /// Append a message blob id + bump seq.
    public entry fun append(head: &mut ConversationHead, blob: String, ts: u64) {
        vector::push_back(&mut head.blobs, blob);
        head.seq = head.seq + 1;
        head.updated_at = ts;
    }

    // ── Seal access-control policy (the differentiator, §6.4) ──────────────────
    // seal_approve is dry-run by Seal key servers: if it aborts, no key share is
    // issued. LEAD WITH THE FALLBACK (gateway issues a session key on a valid proof);
    // the clean version checks an unspent nullifier against a shared registry object.
    // Stub below approves conversation participants; wire the nullifier registry next.
    //
    // public entry fun seal_approve(id: vector<u8>, head: &ConversationHead, ctx: &TxContext) {
    //     // assert the caller/identity is a participant, or holds a valid nullifier.
    // }
}
