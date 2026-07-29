// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LortnocRegistrar, ILortnocRegistry, IVerifiableFactory, INullifierGate} from "../src/LortnocRegistrar.sol";
import {
    MockLortnocRegistry,
    MockVerifiableFactory,
    MockPermissionedResolver,
    MockNullifierGate
} from "./mocks/MockEns.sol";

/// @notice Unit tests for permissionless handle issuance on ENS v2 (CLAUDE.md §6.5).
///
/// The headline claim this contract makes is a security claim: `claim()` is ONE transaction in
/// which the registrar deploys the caller's resolver, writes their records, hands them every
/// role, and then **drops its own** — so afterwards it has no authority over the handle at all.
/// That is the ENS-booth demo, and it was asserted only by a deploy script against live Sepolia.
/// These tests assert it locally, including the ordering constraint that makes it work.
contract LortnocRegistrarTest is Test {
    MockLortnocRegistry internal registry;
    MockVerifiableFactory internal factory;
    LortnocRegistrar internal registrar;

    address internal resolverImpl = makeAddr("PermissionedResolverImpl");
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal relayer = makeAddr("relayer");

    bytes32 internal constant PARENT_NODE = keccak256("lortnoctahc.eth");
    string internal constant PUBKEY = "0xabababababababababababababababababababababababababababababababab";

    event HandleClaimed(
        string label, address indexed claimant, address indexed resolver, uint256 tokenId, bytes32 node
    );
    event RelayerChanged(address indexed relayer, bool allowed);
    event GateChanged(address indexed gate);

    function setUp() public {
        registry = new MockLortnocRegistry();
        factory = new MockVerifiableFactory();
        registrar = new LortnocRegistrar(
            ILortnocRegistry(address(registry)),
            IVerifiableFactory(address(factory)),
            resolverImpl,
            PARENT_NODE,
            owner
        );
        registry.setRegistrar(address(registrar), true);
    }

    // ---- the flagship guarantee --------------------------------------------------------------

    function test_claim_handsOverEveryRoleAndKeepsNone() public {
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);

        MockPermissionedResolver r = MockPermissionedResolver(resolver);
        assertTrue(r.hasRoles(alice), "the claimant did not receive roles on their own resolver");
        assertFalse(
            r.hasRoles(address(registrar)),
            "THE REGISTRAR KEPT AUTHORITY OVER THE HANDLE - the core section 6.5 claim is false"
        );
    }

    function test_claim_afterwardsTheRegistrarCannotWriteRecords() public {
        // The same guarantee stated as a behaviour rather than a bitmap.
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        bytes32 node = registrar.nodeOf("alice");

        vm.expectRevert(abi.encodeWithSelector(MockPermissionedResolver.NotAuthorized.selector, address(registrar)));
        vm.prank(address(registrar));
        MockPermissionedResolver(resolver).setText(node, "eth.lortnoc.pubkey", "hijacked");
    }

    function test_claim_theOwnerCanStillWriteTheirOwnRecords() public {
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        bytes32 node = registrar.nodeOf("alice");

        vm.prank(alice);
        MockPermissionedResolver(resolver).setText(node, "eth.lortnoc.inbox", "relay://topic");
        assertEq(MockPermissionedResolver(resolver).text(node, "eth.lortnoc.inbox"), "relay://topic");
    }

    function test_claim_writesBothPubkeyAndAddr() public {
        // The 2026-07-27 resolution bug: `_claim` wrote only the text record, so every handle
        // reported addr = 0x0 and explorers rendered the name as "does not resolve". `addr` MUST
        // be written in this transaction, because the next step revokes the only authority the
        // registrar ever holds.
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        bytes32 node = registrar.nodeOf("alice");

        MockPermissionedResolver r = MockPermissionedResolver(resolver);
        assertEq(r.text(node, "eth.lortnoc.pubkey"), PUBKEY);
        assertEq(r.addr(node), alice, "addr was not set - explorers will report the name as unresolvable");
    }

    function test_claim_registersTheSubnamePointingAtThatResolver() public {
        vm.prank(alice);
        (address resolver, uint256 tokenId) = registrar.claim("alice", PUBKEY);

        assertEq(registry.findOwner("alice"), alice);
        assertEq(registry.getResolver("alice"), resolver);
        assertGt(tokenId, 0);

        MockLortnocRegistry.Entry memory e = registry.entryOf("alice");
        assertEq(e.registry, address(0), "a nested subregistry was set");
        assertEq(e.expiry, uint64(block.timestamp) + registrar.DURATION());
    }

    function test_claim_resolverIsFactoryDeployedWithTheCanonicalImpl() public {
        // §6.5 use #4: `verifyContract(proxy)` returning the canonical impl is the trustless
        // handle proof a counterparty checks.
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        assertEq(factory.verifyContract(resolver), resolverImpl);
    }

    function test_claim_resolverAddressIsDeterministicFromTheLabel() public {
        // CREATE2 on the node means the resolver address is predictable before deployment.
        address predicted = _predictResolver(registrar.nodeOf("alice"));
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        assertEq(resolver, predicted);
    }

    function test_claim_emitsHandleClaimed() public {
        bytes32 node = registrar.nodeOf("alice");
        address predicted = _predictResolver(node);

        vm.expectEmit(true, true, false, true);
        emit HandleClaimed("alice", alice, predicted, 1, node);
        vm.prank(alice);
        registrar.claim("alice", PUBKEY);
    }

    function test_claim_isPermissionless_anyWalletMayClaim() public {
        vm.prank(bob);
        registrar.claim("bob", PUBKEY);
        assertEq(registry.findOwner("bob"), bob);
    }

    function test_claim_twoUsersGetDistinctResolvers() public {
        vm.prank(alice);
        (address ra,) = registrar.claim("alice", PUBKEY);
        vm.prank(bob);
        (address rb,) = registrar.claim("bob", PUBKEY);
        assertTrue(ra != rb);
        assertFalse(MockPermissionedResolver(ra).hasRoles(bob), "bob has roles on alice's resolver");
        assertFalse(MockPermissionedResolver(rb).hasRoles(alice), "alice has roles on bob's resolver");
    }

    // ---- rejection paths ---------------------------------------------------------------------

    function test_claim_rejectsATakenLabel() public {
        vm.prank(alice);
        registrar.claim("alice", PUBKEY);

        vm.expectRevert(abi.encodeWithSelector(LortnocRegistrar.LabelTaken.selector, "alice"));
        vm.prank(bob);
        registrar.claim("alice", PUBKEY);
    }

    function test_claim_rejectsAnEmptyPubkey() public {
        // Without a messaging key the handle resolves to nothing anyone can write to.
        vm.expectRevert(LortnocRegistrar.EmptyPubkey.selector);
        vm.prank(alice);
        registrar.claim("alice", "");
    }

    function test_claim_labelRules() public {
        // Deliberately narrow: lowercase ASCII only, so a handle cannot be homograph-spoofed.
        string[9] memory bad = ["ab", "-alice", "alice-", "Alice", "al ice", "al_ice", "al.ice", unicode"alicé", ""];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(LortnocRegistrar.InvalidLabel.selector, bad[i]));
            vm.prank(alice);
            registrar.claim(bad[i], PUBKEY);
        }
    }

    function test_claim_acceptsTheValidShapes() public {
        string[5] memory good = ["abc", "a-b", "alice2026", "0123", "a12345678901234567890123456789012"];
        // the last is 33 chars, which must FAIL — assert the boundary explicitly below instead
        for (uint256 i; i < 4; ++i) {
            vm.prank(alice);
            registrar.claim(good[i], PUBKEY);
            assertEq(registry.findOwner(good[i]), alice);
        }
        assertFalse(registrar.available(good[4]), "a 33-character label was accepted");
    }

    function test_claim_labelLengthBoundaries() public {
        assertFalse(registrar.available("ab"), "2 chars should be too short");
        assertTrue(registrar.available("abc"), "3 chars should be the minimum");
        assertTrue(registrar.available("abcdefghijabcdefghijabcdefghijab"), "32 chars should be the maximum");
        assertFalse(registrar.available("abcdefghijabcdefghijabcdefghijabc"), "33 chars should be too long");
    }

    function test_available_reflectsRegistration() public {
        assertTrue(registrar.available("alice"));
        vm.prank(alice);
        registrar.claim("alice", PUBKEY);
        assertFalse(registrar.available("alice"));
    }

    // ---- relayed claims (§8 Layer 1: payer ≠ claimer) ----------------------------------------

    function test_claimFor_mintsToTheClaimantNotTheRelayer() public {
        vm.prank(owner);
        registrar.setRelayer(relayer, true);

        vm.prank(relayer);
        (address resolver,) = registrar.claimFor("alice", PUBKEY, alice);

        // The relayer paid the gas and must own nothing.
        assertEq(registry.findOwner("alice"), alice, "the relayer took the handle");
        assertEq(MockPermissionedResolver(resolver).addr(registrar.nodeOf("alice")), alice);
        assertTrue(MockPermissionedResolver(resolver).hasRoles(alice));
        assertFalse(MockPermissionedResolver(resolver).hasRoles(relayer), "the relayer kept roles");
        assertFalse(MockPermissionedResolver(resolver).hasRoles(address(registrar)));
    }

    function test_claimFor_rejectsAnUnauthorizedRelayer() public {
        vm.expectRevert(LortnocRegistrar.NotRelayer.selector);
        vm.prank(bob);
        registrar.claimFor("alice", PUBKEY, alice);
    }

    function test_claimFor_rejectsAZeroClaimant() public {
        vm.prank(owner);
        registrar.setRelayer(relayer, true);
        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        vm.prank(relayer);
        registrar.claimFor("alice", PUBKEY, address(0));
    }

    function test_setRelayer_isOwnerOnlyAndRevocable() public {
        vm.expectRevert(LortnocRegistrar.NotOwner.selector);
        vm.prank(alice);
        registrar.setRelayer(relayer, true);

        vm.expectEmit(true, false, false, true);
        emit RelayerChanged(relayer, true);
        vm.prank(owner);
        registrar.setRelayer(relayer, true);
        assertTrue(registrar.isRelayer(relayer));

        vm.prank(owner);
        registrar.setRelayer(relayer, false);
        vm.expectRevert(LortnocRegistrar.NotRelayer.selector);
        vm.prank(relayer);
        registrar.claimFor("alice", PUBKEY, alice);
    }

    function test_relayerStatusDoesNotSurviveARedeploy() public {
        // "Redeploying the registrar does NOT carry over isRelayer: setRelayer must be re-run or
        // every relayed claim reverts NotRelayer." Pinned, because it cost a live outage.
        vm.prank(owner);
        registrar.setRelayer(relayer, true);

        LortnocRegistrar fresh = new LortnocRegistrar(
            ILortnocRegistry(address(registry)), IVerifiableFactory(address(factory)),
            resolverImpl, PARENT_NODE, owner
        );
        assertFalse(fresh.isRelayer(relayer), "a fresh registrar must not inherit relayers");
    }

    // ---- the paid tier gate (§7) -------------------------------------------------------------

    function test_gateUnset_isTheFreeTier() public {
        assertEq(address(registrar.gate()), address(0));
        vm.prank(alice);
        registrar.claim("alice", PUBKEY); // no revert
    }

    function test_gateSet_closesTheFreeClaimPath() public {
        MockNullifierGate gate = new MockNullifierGate();
        vm.prank(owner);
        registrar.setGate(INullifierGate(address(gate)));

        vm.expectRevert(LortnocRegistrar.GateIsSet.selector);
        vm.prank(alice);
        registrar.claim("alice", PUBKEY);
    }

    function test_claimWithProof_requiresAGate() public {
        vm.expectRevert(LortnocRegistrar.GateNotSet.selector);
        vm.prank(alice);
        registrar.claimWithProof("alice", PUBKEY, bytes32(uint256(1)));
    }

    function test_claimWithProof_spendsTheNullifierAndMints() public {
        MockNullifierGate gate = new MockNullifierGate();
        vm.prank(owner);
        registrar.setGate(INullifierGate(address(gate)));

        bytes32 nullifier = keccak256("nullifier-1");
        vm.prank(alice);
        registrar.claimWithProof("alice", PUBKEY, nullifier);

        assertTrue(gate.spent(nullifier));
        assertEq(gate.spentBy(nullifier), alice);
        assertEq(registry.findOwner("alice"), alice);
    }

    function test_claimWithProof_rejectsASpentNullifier() public {
        // One membership buys one handle (§7: fixed scope ⇒ fixed nullifier).
        MockNullifierGate gate = new MockNullifierGate();
        vm.prank(owner);
        registrar.setGate(INullifierGate(address(gate)));

        bytes32 nullifier = keccak256("nullifier-1");
        vm.prank(alice);
        registrar.claimWithProof("alice", PUBKEY, nullifier);

        vm.expectRevert(abi.encodeWithSelector(MockNullifierGate.NullifierSpent.selector, nullifier));
        vm.prank(alice);
        registrar.claimWithProof("alice2", PUBKEY, nullifier);
    }

    function test_claimWithProof_aRejectedGateMintsNothing() public {
        MockNullifierGate gate = new MockNullifierGate();
        vm.prank(owner);
        registrar.setGate(INullifierGate(address(gate)));
        gate.setShouldRevert(true);

        vm.expectRevert(MockNullifierGate.GateRejected.selector);
        vm.prank(alice);
        registrar.claimWithProof("alice", PUBKEY, keccak256("n"));

        assertEq(registry.findOwner("alice"), address(0), "a rejected proof still minted a handle");
    }

    function test_setGate_isOwnerOnly() public {
        vm.expectRevert(LortnocRegistrar.NotOwner.selector);
        vm.prank(alice);
        registrar.setGate(INullifierGate(makeAddr("gate")));
    }

    // ---- misc --------------------------------------------------------------------------------

    function test_nodeOf_isNamehashUnderTheParent() public view {
        assertEq(
            registrar.nodeOf("alice"),
            keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes("alice"))))
        );
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(0)), IVerifiableFactory(address(factory)), resolverImpl, PARENT_NODE, owner);

        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(registry)), IVerifiableFactory(address(0)), resolverImpl, PARENT_NODE, owner);

        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(registry)), IVerifiableFactory(address(factory)), address(0), PARENT_NODE, owner);

        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(registry)), IVerifiableFactory(address(factory)), resolverImpl, PARENT_NODE, address(0));
    }

    function test_claim_revertsIfTheRegistrarLacksROLE_REGISTRAR() public {
        // The failure mode after a redeploy where roles were not moved across.
        registry.setRegistrar(address(registrar), false);
        vm.expectRevert(MockLortnocRegistry.NotRegistrar.selector);
        vm.prank(alice);
        registrar.claim("alice", PUBKEY);
    }

    function testFuzz_claim_anyValidLabelMintsToTheCaller(uint8 len, address claimant) public {
        vm.assume(claimant != address(0));
        len = uint8(bound(len, 3, 32));
        bytes memory label = new bytes(len);
        for (uint256 i; i < len; ++i) label[i] = bytes1(uint8(97 + (i % 26)));

        vm.prank(claimant);
        (address resolver,) = registrar.claim(string(label), PUBKEY);

        assertEq(registry.findOwner(string(label)), claimant);
        assertTrue(MockPermissionedResolver(resolver).hasRoles(claimant));
        assertFalse(MockPermissionedResolver(resolver).hasRoles(address(registrar)));
    }

    // ---- helpers -----------------------------------------------------------------------------

    function _predictResolver(bytes32 node) internal view returns (address) {
        bytes32 outerSalt = keccak256(abi.encode(address(registrar), uint256(node)));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(factory),
                            outerSalt,
                            keccak256(type(MockPermissionedResolver).creationCode)
                        )
                    )
                )
            )
        );
    }
}
