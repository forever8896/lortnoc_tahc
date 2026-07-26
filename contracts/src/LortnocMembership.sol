// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title LortnocMembership — anonymous paid membership, settled on 0G Chain (§7, §8)
/// @notice Payment, registration and membership are the same act. Paying inserts your Semaphore
///         identity commitment into the paid-members set. Later — ideally much later (§8 Layer 2)
///         — you prove *"I know the secret behind SOME commitment in that set"* and burn a
///         nullifier. The proof carries your fresh handle pubkey as its message.
///
///         What an observer sees: `wallet X paid` and `the tree grew`. What they cannot see:
///         which membership a given nullifier — and therefore which handle — came from. The link
///         `wallet → commitment` is public; `commitment → nullifier → handle` is severed by the
///         zero-knowledge proof. That is the whole guarantee, and it is unlinkability, not
///         invisibility (§8).
///
/// @dev Deployed on 0G Galileo (chain 16602), which has the bn254 precompiles (0x06/0x07/0x08)
///      Groth16 verification needs — verified before writing this.
///
///      Membership lives here; the handle is issued on Sepolia by `LortnocRegistrar`. No chain
///      can read another's state, so a relayer observes `TicketSpent` here and calls `claimFor`
///      there. That relayer is a trust assumption and we say so out loud (§8 Layer 4): it can
///      censor or stall a claim, it cannot forge one (the nullifier is burned on-chain here) and
///      it never learns which payment a ticket came from — nobody does, including us.
contract LortnocMembership {
    ISemaphore public immutable SEMAPHORE;

    /// @dev The paid-members set. One group; the anonymity set is every member of it, so a bigger
    ///      group is a stronger guarantee (§8: "privacy = the size of the paid crowd").
    uint256 public immutable GROUP_ID;

    address public owner;
    address public treasury;

    /// @dev Price of one membership. Symbolic on testnet — the mechanism is what is being shown.
    uint256 public price;

    /// @dev Commitments already inserted, so a double-join cannot quietly waste someone's money.
    mapping(uint256 commitment => bool) public joined;

    /// @dev Tickets already spent. Semaphore also rejects a reused nullifier inside
    ///      `validateProof`; this mapping is what off-chain callers read, and it makes the
    ///      double-spend revert legible instead of an opaque library error.
    mapping(uint256 nullifier => bool) public spent;

    uint256 public memberCount;

    event Joined(uint256 indexed commitment, address indexed payer, uint256 memberCount);
    event TicketSpent(uint256 indexed nullifier, uint256 message, address indexed relayer);
    event PriceChanged(uint256 price);
    event TreasuryChanged(address treasury);

    error NotOwner();
    error AlreadyJoined(uint256 commitment);
    error TicketAlreadySpent(uint256 nullifier);
    error Underpaid(uint256 sent, uint256 required);
    error ZeroAddress();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(ISemaphore semaphore, uint256 price_, address treasury_, address owner_) {
        if (address(semaphore) == address(0) || treasury_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        SEMAPHORE = semaphore;
        price = price_;
        treasury = treasury_;
        owner = owner_;
        // This contract is the group admin, so only `join` can add members — membership cannot
        // be granted out of band, which is what makes "in the set" mean "paid".
        GROUP_ID = semaphore.createGroup(address(this));
    }

    /// @notice Pay and join the anonymous members set.
    /// @param commitment The Semaphore identity commitment, derived locally from `id_sem`
    ///        (§5.1). The secret behind it never leaves the device — not even to us.
    function join(uint256 commitment) external payable {
        if (msg.value < price) revert Underpaid(msg.value, price);
        if (joined[commitment]) revert AlreadyJoined(commitment);

        joined[commitment] = true;
        memberCount += 1;
        SEMAPHORE.addMember(GROUP_ID, commitment);

        (bool sent,) = treasury.call{value: msg.value}("");
        if (!sent) revert TransferFailed();

        emit Joined(commitment, msg.sender, memberCount);
    }

    /// @notice Spend a membership ticket: prove set membership and burn the nullifier.
    /// @dev Anyone may submit — normally the relayer, so the claimant never needs gas here and
    ///      the payer is not the claimer (§8 Layer 1). The proof is what carries authority; the
    ///      submitter is irrelevant, which is exactly why relaying is safe.
    /// @param proof Semaphore proof. `proof.message` carries the handle pubkey being claimed and
    ///        is bound into the proof, so a relayer cannot swap in a different one.
    function spendTicket(ISemaphore.SemaphoreProof calldata proof) external {
        if (spent[proof.nullifier]) revert TicketAlreadySpent(proof.nullifier);
        spent[proof.nullifier] = true;

        // Reverts unless the proof verifies against a recent root of THIS group.
        SEMAPHORE.validateProof(GROUP_ID, proof);

        emit TicketSpent(proof.nullifier, proof.message, msg.sender);
    }

    /// @notice Whether a ticket can still be spent — what the relayer checks before acting.
    function isSpendable(uint256 nullifier) external view returns (bool) {
        return !spent[nullifier];
    }

    // ---- admin -----------------------------------------------------------------------------

    function setPrice(uint256 price_) external onlyOwner {
        price = price_;
        emit PriceChanged(price_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        owner = to;
    }
}
