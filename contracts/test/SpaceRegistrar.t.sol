// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SpaceRegistrar} from "../src/SpaceRegistrar.sol";
import {ILortnocRegistry, IVerifiableFactory} from "../src/LortnocRegistrar.sol";
import {LortnocSpaces} from "../src/LortnocSpaces.sol";
import {MockLortnocRegistry, MockVerifiableFactory, MockPermissionedResolver} from "./mocks/MockEns.sol";

/// @notice Unit tests for `<label>.space.lortnoctahc.eth` issuance (docs/PRD-universal.md §23.1)
///         against mocks of the 09-15 shapes. SpaceRegistrar.fork.t.sol runs the real bytecode.
contract SpaceRegistrarTest is Test {
    MockLortnocRegistry internal registry;
    MockVerifiableFactory internal factory;
    SpaceRegistrar internal registrar;

    address internal resolverImpl = makeAddr("PermissionedResolverImpl");
    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal alice = makeAddr("alice");
    address internal mod = makeAddr("moderator");

    // space.lortnoctahc.eth
    bytes internal constant PARENT_DNS = hex"057370616365" hex"0b6c6f72746e6f637461686303657468" hex"00";
    string internal constant TOKEN = "eip155:11155111/erc721:0x00000000000000000000000000000000000000aa";

    event SpaceClaimed(
        string label, address indexed spaceOwner, address indexed resolver, uint256 tokenId, bytes32 node, string token
    );

    function setUp() public {
        registry = new MockLortnocRegistry();
        factory = new MockVerifiableFactory();
        registrar = new SpaceRegistrar(
            ILortnocRegistry(address(registry)), IVerifiableFactory(address(factory)), resolverImpl, PARENT_DNS, owner
        );
        registry.setRegistrar(address(registrar), true);
        vm.prank(owner);
        registrar.setRelayer(relayer, true);
    }

    function _claim(string memory label, address to, string memory token) internal returns (address res) {
        vm.prank(relayer);
        (res,) = registrar.claimSpaceFor(label, to, token);
    }

    // ---- records --------------------------------------------------------------------------------

    function test_claim_writesAddrTokenAndEmptyBans() public {
        address res = _claim("lentil-club", alice, TOKEN);
        bytes memory name = registrar.dnsNameOf("lentil-club");
        MockPermissionedResolver r = MockPermissionedResolver(res);
        assertEq(r.addrOf(name), alice, "addr(60) == owner");
        assertEq(r.textOf(name, "eth.lortnoc.space.token"), TOKEN);
        assertEq(r.textOf(name, "eth.lortnoc.space.bans"), "");
        assertEq(registry.findOwner("lentil-club"), alice, "registry owner == space owner");
        assertEq(registry.getResolver("lentil-club"), res);
        assertEq(factory.verifyContract(res), resolverImpl);
    }

    function test_claim_emptyTokenMeansNoGate() public {
        address res = _claim("open-space", alice, "");
        assertEq(MockPermissionedResolver(res).textOf(registrar.dnsNameOf("open-space"), "eth.lortnoc.space.token"), "");
    }

    function test_dnsNameAndNode() public view {
        assertEq(
            registrar.dnsNameOf("abc"),
            hex"03616263" hex"057370616365" hex"0b6c6f72746e6f637461686303657468" hex"00",
            "abc.space.lortnoctahc.eth"
        );
        bytes32 eth = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        bytes32 parent = keccak256(abi.encodePacked(eth, keccak256("lortnoctahc")));
        bytes32 space = keccak256(abi.encodePacked(parent, keccak256("space")));
        assertEq(registrar.PARENT_NODE(), space);
        assertEq(registrar.nodeOf("abc"), keccak256(abi.encodePacked(space, keccak256("abc"))));
    }

    function test_claim_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit SpaceClaimed("lentil-club", alice, address(0), 0, bytes32(0), TOKEN);
        _claim("lentil-club", alice, TOKEN);
    }

    // ---- authority --------------------------------------------------------------------------------

    function test_registrarKeepsNoRole() public {
        address res = _claim("lentil-club", alice, TOKEN);
        MockPermissionedResolver r = MockPermissionedResolver(res);
        assertTrue(r.hasRoles(alice));
        assertFalse(r.hasRoles(address(registrar)), "registrar kept authority over the space");
        assertFalse(r.hasRoles(relayer), "relayer got authority over the space");
        bytes memory name = registrar.dnsNameOf("lentil-club");
        vm.prank(address(registrar));
        vm.expectRevert(abi.encodeWithSelector(MockPermissionedResolver.NotAuthorized.selector, address(registrar)));
        r.setText(name, "eth.lortnoc.space.bans", "member-evil");
        vm.prank(alice);
        r.setText(name, "eth.lortnoc.space.bans", "member-0123456789ab");
        assertEq(r.textOf(name, "eth.lortnoc.space.bans"), "member-0123456789ab");
    }

    function test_onlyRelayer() public {
        vm.prank(alice);
        vm.expectRevert(SpaceRegistrar.NotRelayer.selector);
        registrar.claimSpaceFor("lentil-club", alice, TOKEN);
        vm.prank(owner); // the owner is NOT implicitly a relayer
        vm.expectRevert(SpaceRegistrar.NotRelayer.selector);
        registrar.claimSpaceFor("lentil-club", alice, TOKEN);
    }

    function test_setRelayer_onlyOwner_andRevocable() public {
        vm.prank(alice);
        vm.expectRevert(SpaceRegistrar.NotOwner.selector);
        registrar.setRelayer(alice, true);
        vm.prank(owner);
        registrar.setRelayer(relayer, false);
        vm.prank(relayer);
        vm.expectRevert(SpaceRegistrar.NotRelayer.selector);
        registrar.claimSpaceFor("lentil-club", alice, TOKEN);
    }

    function test_transferOwnership() public {
        vm.prank(owner);
        registrar.transferOwnership(alice);
        assertEq(registrar.owner(), alice);
        vm.prank(owner);
        vm.expectRevert(SpaceRegistrar.NotOwner.selector);
        registrar.setRelayer(owner, true);
        vm.prank(alice);
        vm.expectRevert(SpaceRegistrar.ZeroAddress.selector);
        registrar.transferOwnership(address(0));
    }

    // ---- input rules ------------------------------------------------------------------------------

    function test_takenLabelReverts() public {
        _claim("lentil-club", alice, TOKEN);
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SpaceRegistrar.LabelTaken.selector, "lentil-club"));
        registrar.claimSpaceFor("lentil-club", mod, "");
        assertFalse(registrar.available("lentil-club"));
    }

    function test_zeroOwnerReverts() public {
        vm.prank(relayer);
        vm.expectRevert(SpaceRegistrar.ZeroAddress.selector);
        registrar.claimSpaceFor("lentil-club", address(0), TOKEN);
    }

    function test_tokenTooLongReverts() public {
        bytes memory big = new bytes(257);
        for (uint256 i; i < big.length; ++i) big[i] = "a";
        vm.prank(relayer);
        vm.expectRevert(SpaceRegistrar.TokenTooLong.selector);
        registrar.claimSpaceFor("lentil-club", alice, string(big));
    }

    function test_labelRules() public {
        string[7] memory bad = ["ab", "-abc", "abc-", "ABC", "a_bc", "abc.def", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(registrar.validLabel(bad[i]), bad[i]);
            assertFalse(registrar.available(bad[i]), bad[i]);
            vm.prank(relayer);
            vm.expectRevert(abi.encodeWithSelector(SpaceRegistrar.InvalidLabel.selector, bad[i]));
            registrar.claimSpaceFor(bad[i], alice, "");
        }
        assertTrue(registrar.validLabel("a-b"));
        assertTrue(registrar.validLabel("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")); // 32
    }

    /// The purchase contract and the registrar must agree on every label, or someone can pay for
    /// a space we then refuse to create.
    function testFuzz_labelRuleMatchesLortnocSpaces(string calldata label) public {
        LortnocSpaces spaces = new LortnocSpaces(0, 0, 0, address(1), address(this));
        assertEq(registrar.validLabel(label), spaces.validLabel(label));
    }

    function test_reissueAfterExpiry_usesFreshSalt() public {
        address res1 = _claim("lentil-club", alice, TOKEN);
        registry.release("lentil-club"); // expiry
        address res2 = _claim("lentil-club", mod, "");
        assertTrue(res1 != res2, "CREATE2 collision on re-issue");
        assertEq(registry.findOwner("lentil-club"), mod);
    }
}
