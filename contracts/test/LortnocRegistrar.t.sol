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
/// which the registrar deploys the caller's resolver, has its INITIALIZER write their records,
/// and grants roles to the claimant only — at 09-15 the registrar never holds a role on a handle
/// resolver at all, not even for one transaction. These tests assert it against mocks of the
/// 09-15 shapes; `LortnocRegistrar.fork.t.sol` asserts it against the real bytecode.
contract LortnocRegistrarTest is Test {
    MockLortnocRegistry internal registry;
    MockVerifiableFactory internal factory;
    LortnocRegistrar internal registrar;

    address internal resolverImpl = makeAddr("PermissionedResolverImpl");
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal relayer = makeAddr("relayer");

    bytes internal constant PARENT_DNS = hex"0b6c6f72746e6f63746168630365746800"; // lortnoctahc.eth
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
            PARENT_DNS,
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
        bytes memory name = registrar.dnsNameOf("alice");

        vm.expectRevert(abi.encodeWithSelector(MockPermissionedResolver.NotAuthorized.selector, address(registrar)));
        vm.prank(address(registrar));
        MockPermissionedResolver(resolver).setText(name, "eth.lortnoc.pubkey", "hijacked");
    }

    function test_claim_theOwnerCanStillWriteTheirOwnRecords() public {
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        bytes memory name = registrar.dnsNameOf("alice");

        vm.prank(alice);
        MockPermissionedResolver(resolver).setText(name, "eth.lortnoc.inbox", "relay://topic");
        assertEq(MockPermissionedResolver(resolver).textOf(name, "eth.lortnoc.inbox"), "relay://topic");
    }

    function test_claim_writesBothPubkeyAndAddr() public {
        // The 2026-07-27 resolution bug: `_claim` wrote only the text record, so every handle
        // reported addr = 0x0 and explorers rendered the name as "does not resolve". `addr` MUST
        // be written by the initializer: afterwards the registrar has no authority to write it.
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        bytes memory name = registrar.dnsNameOf("alice");

        MockPermissionedResolver r = MockPermissionedResolver(resolver);
        assertEq(r.textOf(name, "eth.lortnoc.pubkey"), PUBKEY);
        assertEq(r.addrOf(name), alice, "addr was not set - explorers will report the name as unresolvable");
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
        // CREATE2 on predictSalt(node, 0) == node: predictable before deployment.
        address predicted = _predictResolver(registrar.predictSalt(registrar.nodeOf("alice"), 0));
        vm.prank(alice);
        (address resolver,) = registrar.claim("alice", PUBKEY);
        assertEq(resolver, predicted);
    }

    function test_claim_emitsHandleClaimed() public {
        bytes32 node = registrar.nodeOf("alice");
        address predicted = _predictResolver(uint256(node));

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
        assertEq(MockPermissionedResolver(resolver).addrOf(registrar.dnsNameOf("alice")), alice);
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
            resolverImpl, PARENT_DNS, owner
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
        bytes32 parent = keccak256(abi.encodePacked(
            keccak256(abi.encodePacked(bytes32(0), keccak256("eth"))), keccak256("lortnoctahc")
        ));
        assertEq(registrar.PARENT_NODE(), parent, "parent node derived from the DNS name");
        assertEq(registrar.nodeOf("alice"), keccak256(abi.encodePacked(parent, keccak256(bytes("alice")))));
    }

    function test_dnsNameOf_isTheWireFormTheSettersTake() public view {
        assertEq(registrar.dnsNameOf("alice"), abi.encodePacked(uint8(5), "alice", PARENT_DNS));
    }

    // ---- 09-15 additions: re-claim after expiry, one-shot migration ---------------------------

    function test_reclaimAfterExpiry_getsAFreshResolver() public {
        // The 06-29 contract used salt = node, so a lapsed label could never be re-claimed: the
        // second deployProxy CREATE2-collided forever. predictSalt(node, n) fixes that.
        vm.prank(alice);
        (address r1,) = registrar.claim("alice", PUBKEY);
        registry.release("alice"); // expiry
        vm.prank(bob);
        (address r2,) = registrar.claim("alice", PUBKEY);
        assertTrue(r1 != r2);
        assertEq(r2, _predictResolver(registrar.predictSalt(registrar.nodeOf("alice"), 1)));
        assertEq(registry.findOwner("alice"), bob);
    }

    function test_migrate_carriesRecordsVerbatim_andAddrIsTheClaimant() public {
        string[] memory k = new string[](2);
        string[] memory v = new string[](2);
        k[0] = "eth.lortnoc.knock";
        v[0] = '{"prompt":"bar?","salt":"c2FsdA==","kdf":{"t":2,"m":19456,"p":1}}';
        k[1] = "eth.lortnoc.sui";
        v[1] = "0xabc";
        vm.prank(owner);
        (address resolver,) = registrar.migrate("kirsten", PUBKEY, alice, k, v);
        MockPermissionedResolver r = MockPermissionedResolver(resolver);
        bytes memory name = registrar.dnsNameOf("kirsten");
        assertEq(r.textOf(name, k[0]), v[0], "knock salt must be byte-identical");
        assertEq(r.textOf(name, k[1]), v[1]);
        assertEq(r.textOf(name, "eth.lortnoc.pubkey"), PUBKEY);
        assertEq(r.addrOf(name), alice);
        assertFalse(r.hasRoles(owner), "the registrar owner gained roles on a migrated handle");
        assertFalse(r.hasRoles(address(registrar)));
    }

    function test_migrate_isOwnerOnly_refusesPubkeyKey_andClosesForever() public {
        vm.expectRevert(LortnocRegistrar.NotOwner.selector);
        vm.prank(alice);
        registrar.migrate("kevin", PUBKEY, alice, new string[](0), new string[](0));

        string[] memory bad = new string[](1);
        bad[0] = "eth.lortnoc.pubkey";
        vm.expectRevert(abi.encodeWithSelector(LortnocRegistrar.ReservedKey.selector, bad[0]));
        vm.prank(owner);
        registrar.migrate("kevin", PUBKEY, alice, bad, new string[](1));

        vm.expectRevert(LortnocRegistrar.LengthMismatch.selector);
        vm.prank(owner);
        registrar.migrate("kevin", PUBKEY, alice, new string[](1), new string[](0));

        vm.startPrank(owner);
        registrar.closeMigration();
        assertFalse(registrar.migrationOpen());
        vm.expectRevert(LortnocRegistrar.MigrationIsClosed.selector);
        registrar.migrate("kevin", PUBKEY, alice, new string[](0), new string[](0));
        vm.stopPrank();
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(0)), IVerifiableFactory(address(factory)), resolverImpl, PARENT_DNS, owner);

        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(registry)), IVerifiableFactory(address(0)), resolverImpl, PARENT_DNS, owner);

        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(registry)), IVerifiableFactory(address(factory)), address(0), PARENT_DNS, owner);

        vm.expectRevert(LortnocRegistrar.ZeroAddress.selector);
        new LortnocRegistrar(ILortnocRegistry(address(registry)), IVerifiableFactory(address(factory)), resolverImpl, PARENT_DNS, address(0));
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
        // The fuzzer likes to pick addresses that exist in this test (the registrar itself, the
        // factory, a precompile...). A claimant that IS the registrar trivially "holds roles as
        // the registrar" — that is not the property under test, so exclude in-test contracts.
        vm.assume(claimant.code.length == 0 && uint160(claimant) > 0x100);
        vm.assume(claimant != address(registrar) && claimant != address(factory) && claimant != address(registry));
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

    function _predictResolver(uint256 salt) internal view returns (address) {
        bytes32 outerSalt = keccak256(abi.encode(address(registrar), salt));
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
