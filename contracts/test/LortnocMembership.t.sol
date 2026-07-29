// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {LortnocMembership} from "../src/LortnocMembership.sol";
import {MockSemaphore} from "./mocks/MockSemaphore.sol";

/// @notice Unit tests for the anonymous paid membership (CLAUDE.md §7, §8).
///
/// This contract is live on 0G mainnet holding real value and had no tests. The properties that
/// matter are not the zero-knowledge ones (Semaphore tests those upstream) but the money and the
/// bookkeeping around them: that paying grows the set exactly once, that funds always reach the
/// treasury, that a nullifier cannot be spent twice, and that a rejected proof rolls the burn back.
contract LortnocMembershipTest is Test {
    MockSemaphore internal semaphore;
    LortnocMembership internal membership;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant PRICE = 5.666942 ether;
    uint256 internal constant COMMITMENT = uint256(keccak256("alice-id-sem"));

    event Joined(uint256 indexed commitment, address indexed payer, uint256 memberCount);
    event TicketSpent(uint256 indexed nullifier, uint256 message, address indexed relayer);
    event PriceChanged(uint256 price);
    event TreasuryChanged(address treasury);

    function setUp() public {
        semaphore = new MockSemaphore();
        membership = new LortnocMembership(ISemaphore(address(semaphore)), PRICE, treasury, owner);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
    }

    // ---- construction ------------------------------------------------------------------------

    function test_constructor_setsStateAndOwnsItsGroup() public view {
        assertEq(membership.price(), PRICE);
        assertEq(membership.treasury(), treasury);
        assertEq(membership.owner(), owner);
        assertEq(membership.memberCount(), 0);
        // The contract must be the group admin: that is what makes "in the set" mean "paid".
        // If anyone else could addMember, membership could be granted out of band for free.
        assertEq(semaphore.groupAdmin(membership.GROUP_ID()), address(membership));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(LortnocMembership.ZeroAddress.selector);
        new LortnocMembership(ISemaphore(address(0)), PRICE, treasury, owner);

        vm.expectRevert(LortnocMembership.ZeroAddress.selector);
        new LortnocMembership(ISemaphore(address(semaphore)), PRICE, address(0), owner);

        vm.expectRevert(LortnocMembership.ZeroAddress.selector);
        new LortnocMembership(ISemaphore(address(semaphore)), PRICE, treasury, address(0));
    }

    // ---- join --------------------------------------------------------------------------------

    function test_join_insertsCommitmentAndForwardsPayment() public {
        uint256 before = treasury.balance;

        vm.expectEmit(true, true, false, true);
        emit Joined(COMMITMENT, alice, 1);

        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);

        assertTrue(membership.joined(COMMITMENT));
        assertEq(membership.memberCount(), 1);
        assertEq(semaphore.memberCountOf(membership.GROUP_ID()), 1);
        assertEq(treasury.balance - before, PRICE);
    }

    function test_join_neverLetsTheContractHoldABalance() public {
        // "Fees forward to the treasury on every join(); the contract never holds a balance."
        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);
        vm.prank(bob);
        membership.join{value: PRICE * 3}(uint256(keccak256("bob")));
        assertEq(address(membership).balance, 0, "membership contract is accumulating funds");
    }

    function test_join_revertsWhenUnderpaid() public {
        vm.expectRevert(abi.encodeWithSelector(LortnocMembership.Underpaid.selector, PRICE - 1, PRICE));
        vm.prank(alice);
        membership.join{value: PRICE - 1}(COMMITMENT);

        assertFalse(membership.joined(COMMITMENT));
        assertEq(membership.memberCount(), 0);
    }

    function test_join_acceptsOverpaymentAndForwardsAllOfIt() public {
        vm.prank(alice);
        membership.join{value: PRICE + 1 ether}(COMMITMENT);
        assertEq(treasury.balance, PRICE + 1 ether);
    }

    function test_join_rejectsDoubleJoinSoNobodyPaysTwiceForNothing() public {
        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);

        vm.expectRevert(abi.encodeWithSelector(LortnocMembership.AlreadyJoined.selector, COMMITMENT));
        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);

        assertEq(membership.memberCount(), 1);
        assertEq(treasury.balance, PRICE, "a rejected double-join still took the money");
    }

    function test_join_doubleJoinIsRejectedEvenFromADifferentPayer() public {
        // The commitment is the identity, not the wallet. Someone else paying for the same
        // commitment must not grow the set twice.
        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);

        vm.expectRevert(abi.encodeWithSelector(LortnocMembership.AlreadyJoined.selector, COMMITMENT));
        vm.prank(bob);
        membership.join{value: PRICE}(COMMITMENT);
    }

    function test_join_growsTheAnonymitySet() public {
        // §8: "privacy = the size of the paid crowd".
        for (uint256 i = 1; i <= 5; ++i) {
            address payer = address(uint160(0x1000 + i));
            vm.deal(payer, PRICE);
            vm.prank(payer);
            membership.join{value: PRICE}(uint256(keccak256(abi.encode("member", i))));
            assertEq(membership.memberCount(), i);
        }
        assertEq(semaphore.memberCountOf(membership.GROUP_ID()), 5);
    }

    function test_join_revertsIfTheTreasuryRejectsPayment() public {
        // Deploy first: vm.prank applies to the very next call, and `new` is one.
        address rejecting = address(new RejectingTreasury());
        vm.prank(owner);
        membership.setTreasury(rejecting);

        vm.expectRevert(LortnocMembership.TransferFailed.selector);
        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);

        // And nothing was recorded — the whole thing rolled back.
        assertFalse(membership.joined(COMMITMENT));
        assertEq(membership.memberCount(), 0);
    }

    function test_join_atZeroPriceIsFree() public {
        vm.prank(owner);
        membership.setPrice(0);
        vm.prank(alice);
        membership.join{value: 0}(COMMITMENT);
        assertTrue(membership.joined(COMMITMENT));
    }

    function testFuzz_join_anyCommitmentAtOrAbovePriceSucceeds(uint256 commitment, uint96 paid) public {
        vm.assume(paid >= PRICE);
        vm.deal(alice, paid);
        vm.prank(alice);
        membership.join{value: paid}(commitment);
        assertTrue(membership.joined(commitment));
        assertEq(treasury.balance, paid);
    }

    // ---- spendTicket -------------------------------------------------------------------------

    function test_spendTicket_burnsTheNullifierAndValidatesTheProof() public {
        ISemaphore.SemaphoreProof memory proof = _proof(777, 0xBEEF);

        assertTrue(membership.isSpendable(777));

        vm.expectEmit(true, true, false, true);
        emit TicketSpent(777, 0xBEEF, bob);

        vm.prank(bob); // the relayer submits; §8 Layer 1, payer ≠ claimer
        membership.spendTicket(proof);

        assertTrue(membership.spent(777));
        assertFalse(membership.isSpendable(777));
        assertEq(semaphore.validateProofCalls(), 1);
        assertEq(semaphore.lastValidatedGroup(), membership.GROUP_ID());
    }

    function test_spendTicket_rejectsAReusedNullifier() public {
        ISemaphore.SemaphoreProof memory proof = _proof(777, 0xBEEF);
        vm.prank(bob);
        membership.spendTicket(proof);

        vm.expectRevert(abi.encodeWithSelector(LortnocMembership.TicketAlreadySpent.selector, uint256(777)));
        vm.prank(bob);
        membership.spendTicket(proof);
    }

    function test_spendTicket_doubleSpendIsRejectedEvenFromADifferentSubmitter() public {
        // One membership buys one handle: the nullifier, not the submitter, is the limit.
        vm.prank(bob);
        membership.spendTicket(_proof(777, 0xBEEF));

        vm.expectRevert(abi.encodeWithSelector(LortnocMembership.TicketAlreadySpent.selector, uint256(777)));
        vm.prank(alice);
        membership.spendTicket(_proof(777, 0xCAFE)); // different message, same nullifier
    }

    function test_spendTicket_anyoneMaySubmit_theProofCarriesAuthority() public {
        // This is what makes relaying safe: the submitter is irrelevant.
        address randomRelayer = makeAddr("random");
        vm.prank(randomRelayer);
        membership.spendTicket(_proof(1, 2));
        assertTrue(membership.spent(1));
    }

    function test_spendTicket_rejectedProofRollsBackTheNullifierBurn() public {
        // The burn is written BEFORE validateProof. If the proof fails, the whole transaction
        // must revert — otherwise a bad proof would permanently consume someone's real ticket.
        semaphore.setValidateProofShouldRevert(true);

        vm.expectRevert(MockSemaphore.ProofRejected.selector);
        vm.prank(bob);
        membership.spendTicket(_proof(777, 0xBEEF));

        assertFalse(membership.spent(777), "a rejected proof consumed the nullifier anyway");
        assertTrue(membership.isSpendable(777));
    }

    function test_spendTicket_distinctNullifiersAreIndependent() public {
        vm.prank(bob);
        membership.spendTicket(_proof(1, 100));
        vm.prank(bob);
        membership.spendTicket(_proof(2, 200));
        assertTrue(membership.spent(1));
        assertTrue(membership.spent(2));
        assertTrue(membership.isSpendable(3));
    }

    // ---- admin -------------------------------------------------------------------------------

    function test_setPrice_onlyOwner() public {
        vm.expectEmit(false, false, false, true);
        emit PriceChanged(1 ether);
        vm.prank(owner);
        membership.setPrice(1 ether);
        assertEq(membership.price(), 1 ether);

        vm.expectRevert(LortnocMembership.NotOwner.selector);
        vm.prank(alice);
        membership.setPrice(0);
    }

    function test_setTreasury_onlyOwnerAndNeverZero() public {
        address next = makeAddr("next-treasury");
        vm.expectEmit(false, false, false, true);
        emit TreasuryChanged(next);
        vm.prank(owner);
        membership.setTreasury(next);
        assertEq(membership.treasury(), next);

        vm.expectRevert(LortnocMembership.NotOwner.selector);
        vm.prank(alice);
        membership.setTreasury(alice);

        // Zeroing the treasury would send every future join() to address(0).
        vm.expectRevert(LortnocMembership.ZeroAddress.selector);
        vm.prank(owner);
        membership.setTreasury(address(0));
    }

    function test_setTreasury_redirectsSubsequentPayments() public {
        address next = makeAddr("next-treasury");
        vm.prank(owner);
        membership.setTreasury(next);
        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);
        assertEq(next.balance, PRICE);
        assertEq(treasury.balance, 0);
    }

    function test_transferOwnership_onlyOwnerAndNeverZero() public {
        vm.prank(owner);
        membership.transferOwnership(alice);
        assertEq(membership.owner(), alice);

        // The old owner is now powerless.
        vm.expectRevert(LortnocMembership.NotOwner.selector);
        vm.prank(owner);
        membership.setPrice(1);

        vm.expectRevert(LortnocMembership.ZeroAddress.selector);
        vm.prank(alice);
        membership.transferOwnership(address(0));
    }

    function test_adminFunctionsAreNotCallableByAMember() public {
        vm.prank(alice);
        membership.join{value: PRICE}(COMMITMENT);

        vm.expectRevert(LortnocMembership.NotOwner.selector);
        vm.prank(alice);
        membership.setPrice(0);
    }

    // ---- helpers -----------------------------------------------------------------------------

    function _proof(uint256 nullifier, uint256 message)
        internal
        pure
        returns (ISemaphore.SemaphoreProof memory p)
    {
        p.merkleTreeDepth = 20;
        p.merkleTreeRoot = uint256(keccak256("root"));
        p.nullifier = nullifier;
        p.message = message;
        p.scope = uint256(keccak256("lortnoc/claim/v1"));
    }
}

/// @dev A treasury that refuses ETH, to exercise the TransferFailed branch.
contract RejectingTreasury {
    receive() external payable {
        revert("no thanks");
    }
}
