// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// FORK test against the REAL ENS v2 `sepolia-deployment-2026-09-15` bytecode.
//   FORK_RPC=https://ethereum-sepolia-rpc.publicnode.com forge test --root contracts -vv
// Skipped when FORK_RPC is unset.
// The deployer is impersonated with vm.prank; no key is read, nothing is broadcast.

import {Test, console2} from "forge-std/Test.sol";
import {LortnocRegistrar, Grant, ILortnocRegistry, IVerifiableFactory} from "../src/LortnocRegistrar.sol";

interface IUserRegistry {
    function initialize(Grant[] calldata grants) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function setParent(address parent, string calldata label) external;
    function getParent() external view returns (address, string memory);
    function findOwner(string calldata label) external view returns (address);
    function findTokenId(string calldata label) external view returns (uint256);
    function getResolver(string calldata label) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes calldata data) external;
    function unsafeTransfer(address to, uint256 tokenId, bytes calldata data) external;
    function setResolver(uint256 anyId, address resolver) external;
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function isEmancipated() external view returns (bool);
}

interface IETHRegistry {
    function findOwner(string calldata label) external view returns (address);
    function setSubregistry(uint256 anyId, address registry) external;
    function setResolver(uint256 anyId, address resolver) external;
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface IResolver {
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata a) external;
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function grantRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
    function decodeSetter(bytes calldata setter) external pure returns (bytes memory, uint256, uint256);
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
    function linkToRecord(bytes calldata sourceName, uint256 recordId) external;
    function getRecordId(bytes32 node) external view returns (uint256);
    function supportsInterface(bytes4) external view returns (bool);
}

struct RenewData {
    string label;
    uint64 duration;
    bytes32 referrer;
}

interface IETHRegistrar {
    function renew(RenewData calldata rd, address paymentToken) external;
    function getRenewPrice(string calldata label, uint64 duration, address paymentToken) external view returns (uint256);
}

interface IMockUSDC {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 value) external returns (bool);
}

interface IUR {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

interface IUniversalHelper {
    function findExactOwner(bytes calldata name) external view returns (address);
}

interface IRecordReads {
    function addr(bytes32 node) external view returns (address);
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

contract LortnocRegistrarForkTest is Test {
    // ---- sepolia-deployment-2026-09-15 (contracts/deployments/sepolia/addresses.md) ----
    address constant ETH_REGISTRY = 0x657eA849311d3D5823348ddEd7C2AaAFb3EDE09E;
    address constant FACTORY = 0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C;
    address constant RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    address constant USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;
    address constant CANONICAL_UR = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe; // viem default
    address constant UNIVERSAL_HELPER = 0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5;

    address constant ETH_REGISTRAR = 0xAbe76F6C8DFcEd81AA5A2bB8034202A7136b94ca;
    address constant MOCK_USDC = 0x16f95D91DBa7dA3Aca778Ec053dF0FF6C6A8aA8e;
    address constant DEPLOYER = 0x61eE2fBcf2841d9094e2D42406Dd4f83a7981Bb8; // owns lortnoctahc.eth @09-15

    uint256 constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant ROLE_REGISTRAR = 1;
    uint256 constant ROLE_SET_ADDRESS = 1 << 0;
    uint256 constant ROLE_SET_TEXT = 1 << 4;
    uint256 constant ROLE_SET_TEXT_ADMIN = ROLE_SET_TEXT << 128;

    string constant FRIENDS = "eth.lortnoc.audience.friends";
    string constant PUBKEY = "eth.lortnoc.pubkey";

    IUserRegistry registry;
    LortnocRegistrar registrar;
    IResolver parentResolver;
    bytes parentDns;

    address alice = makeAddr("alice-kown");
    address bob = makeAddr("bob-kown");
    address relayer = makeAddr("relayer");
    address delegate = makeAddr("co-admin");

    function dns(string memory a, string memory b, string memory c) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(a).length), a, uint8(bytes(b).length), b, uint8(bytes(c).length), c, uint8(0));
    }

    function setUp() public {
        // Offline by default: the contracts tier must stay green without a network. Set FORK_RPC
        // to an archive-capable Sepolia RPC (or an anvil fork) to run against the real bytecode.
        if (!vm.envExists("FORK_RPC")) {
            vm.skip(true, "FORK_RPC unset");
            return;
        }
        vm.createSelectFork(vm.envString("FORK_RPC"), 11_778_013); // pinned: lortnoctahc.eth registered, subregistry=0
        parentDns = abi.encodePacked(uint8(11), "lortnoctahc", uint8(3), "eth", uint8(0));
        assertEq(IETHRegistry(ETH_REGISTRY).findOwner("lortnoctahc"), DEPLOYER, "fork: deployer must own lortnoctahc.eth");

        vm.startPrank(DEPLOYER);
        // 1. LortnocRegistry = UserRegistry proxy. 09-15: initialize(Grant[]) (was (address,uint256)).
        Grant[] memory g = new Grant[](1);
        g[0] = Grant(DEPLOYER, ALL_ROLES);
        registry = IUserRegistry(
            IVerifiableFactory(FACTORY).deployProxy(
                USER_REGISTRY_IMPL, uint256(keccak256("lortnoc/registry/v3")), abi.encodeCall(IUserRegistry.initialize, (g))
            )
        );
        registry.setParent(ETH_REGISTRY, "lortnoctahc");

        // 2. Registrar, holding ROLE_REGISTRAR only (no admin bit — the 06-29 deploy also gave admin).
        registrar = new LortnocRegistrar(
            ILortnocRegistry(address(registry)), IVerifiableFactory(FACTORY), RESOLVER_IMPL, parentDns, DEPLOYER
        );
        registry.grantRootRoles(ROLE_REGISTRAR, address(registrar));
        registrar.setRelayer(relayer, true);

        // 3. Parent resolver (for lortnoctahc.eth itself), addr written by the initializer.
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(IResolver.setAddress, (parentDns, 60, abi.encodePacked(DEPLOYER)));
        parentResolver = IResolver(
            IVerifiableFactory(FACTORY).deployProxy(
                RESOLVER_IMPL, uint256(keccak256("lortnoc/parent-resolver/v3")), abi.encodeCall(IResolver.initialize, (g, calls))
            )
        );

        // 4. Link into the CURRENT root: ETHRegistry token roles from ETHRegistrar.REGISTRATION_ROLE_BITMAP.
        uint256 labelId = uint256(keccak256("lortnoctahc"));
        IETHRegistry(ETH_REGISTRY).setSubregistry(labelId, address(registry));
        IETHRegistry(ETH_REGISTRY).setResolver(labelId, address(parentResolver));
        vm.stopPrank();
    }

    // ---- helpers ---------------------------------------------------------------------------

    function _urAddr(bytes memory name) internal view returns (address a, address resolverUsed) {
        bytes memory data = abi.encodeCall(IRecordReads.addr, (bytes32(0)));
        (bytes memory r, address res) = IUR(CANONICAL_UR).resolve(name, data);
        return (abi.decode(r, (address)), res);
    }

    function _urText(bytes memory name, string memory key) internal view returns (string memory) {
        (bytes memory r,) = IUR(CANONICAL_UR).resolve(name, abi.encodeCall(IRecordReads.text, (bytes32(0), key)));
        return abi.decode(r, (string));
    }

    function _claimAlice() internal returns (address res, bytes memory name) {
        vm.prank(alice);
        (res,) = registrar.claim("alice", "aa11");
        name = dns("alice", "lortnoctahc", "eth");
    }

    // ---- canonical resolution --------------------------------------------------------------

    function test_parentResolvesThroughCanonicalUR() public view {
        (address a, address res) = _urAddr(parentDns);
        assertEq(a, DEPLOYER);
        assertEq(res, address(parentResolver));
    }

    function test_claim_resolvesAddrAndPubkeyThroughCanonicalUR() public {
        (address res, bytes memory name) = _claimAlice();
        (address a, address used) = _urAddr(name);
        assertEq(a, alice, "addr(60) == claimant");
        assertEq(used, res, "UR picked the handle's own resolver (leaf)");
        assertEq(_urText(name, PUBKEY), "aa11");
        assertEq(IUniversalHelper(UNIVERSAL_HELPER).findExactOwner(name), alice, "registry owner == claimant");
        assertEq(IVerifiableFactory(FACTORY).verifyContract(res), RESOLVER_IMPL, "factory-verified");
    }

    function test_claim_registrarNeverHoldsAnyRoleOnTheHandleResolver() public {
        (address res, bytes memory name) = _claimAlice();
        assertEq(IResolver(res).roles(0, address(registrar)), 0);
        assertEq(IResolver(res).roles(0, FACTORY), 0);
        assertEq(IResolver(res).roles(0, alice), ALL_ROLES, "claimant is sole root admin");
        vm.prank(address(registrar));
        vm.expectRevert();
        IResolver(res).setText(name, PUBKEY, "evil");
    }

    function test_claim_ownerCanWriteOwnRecords() public {
        (address res, bytes memory name) = _claimAlice();
        vm.prank(alice);
        IResolver(res).setText(name, "eth.lortnoc.inbox", "walrus:abc");
        assertEq(_urText(name, "eth.lortnoc.inbox"), "walrus:abc");
    }

    function test_resolverHasNoDirectTextOrAddrView() public {
        // 09-15 BREAKING for app/src/lib/live/ens.ts + extension-x: the "direct resolver" fallback
        // calls text(node,key)/addr(node) on the resolver, which no longer exist as functions.
        (address res,) = _claimAlice();
        (bool ok, bytes memory ret) = res.staticcall(abi.encodeCall(IRecordReads.text, (registrar.nodeOf("alice"), PUBKEY)));
        console2.log("direct text() ok?", ok);
        console2.logBytes(ret);
        assertFalse(ok, "direct text(node,key) must not exist on 09-15 resolver");
    }

    function test_unclaimedLabel_fallsBackToParentResolverAndReadsEmpty() public view {
        // #440: resolver at a non-leaf must implement IExtendedResolver. PermissionedResolver does,
        // so `ghost.lortnoctahc.eth` does NOT revert ResolverNotFound — it reads EMPTY via the parent.
        assertTrue(parentResolver.supportsInterface(0x9061b923)); // IExtendedResolver
        bytes memory ghost = dns("ghost", "lortnoctahc", "eth");
        (address a, address used) = _urAddr(ghost);
        assertEq(a, address(0));
        assertEq(used, address(parentResolver));
        assertEq(IUniversalHelper(UNIVERSAL_HELPER).findExactOwner(ghost), address(0));
    }

    // ---- delegation: grantSetterRoles / revokeRoles (G3) ------------------------------------

    function test_delegation_oneTextKeyOnly_thenRevoke() public {
        (address res, bytes memory name) = _claimAlice();
        IResolver r = IResolver(res);
        bytes memory setter = abi.encodeCall(IResolver.setText, (name, FRIENDS, ""));
        (, uint256 resource, uint256 bitmap) = r.decodeSetter(setter);
        assertEq(resource, uint256(keccak256(bytes(FRIENDS))), "resource = keccak(key), per RESOLVER not per name");
        assertEq(bitmap, ROLE_SET_TEXT);

        vm.prank(delegate);
        vm.expectRevert();
        r.setText(name, FRIENDS, "x"); // before grant

        vm.prank(alice);
        r.grantSetterRoles(setter, delegate);

        vm.prank(delegate);
        r.setText(name, FRIENDS, '["bob.lortnoctahc.eth"]');
        assertEq(_urText(name, FRIENDS), '["bob.lortnoctahc.eth"]');

        vm.startPrank(delegate);
        vm.expectRevert();
        r.setText(name, PUBKEY, "evil");
        vm.expectRevert();
        r.setText(name, "eth.lortnoc.audience.work", "x");
        vm.expectRevert();
        r.setAddress(name, 60, abi.encodePacked(delegate));
        vm.expectRevert(); // delegate holds the role, not its admin: cannot sub-delegate
        r.grantSetterRoles(setter, makeAddr("sub"));
        vm.stopPrank();

        vm.prank(alice);
        r.revokeRoles(resource, ROLE_SET_TEXT, delegate);
        vm.prank(delegate);
        vm.expectRevert();
        r.setText(name, FRIENDS, "after-revoke");
        assertEq(_urText(name, PUBKEY), "aa11");
    }

    function test_delegation_grantRolesIsDisabledOnResolver() public {
        (address res,) = _claimAlice();
        vm.prank(alice);
        vm.expectRevert();
        IResolver(res).grantRoles(uint256(keccak256(bytes(FRIENDS))), ROLE_SET_TEXT, delegate);
    }

    function test_delegation_scopeIsPerResolver_delegateCanWriteThatKeyOnAnyNameInIt() public {
        // Documented property, not a bug for us (one resolver per handle): the delegate can write
        // `audience.friends` on names OTHER than the handle, in that resolver's record space.
        (address res, bytes memory name) = _claimAlice();
        vm.prank(alice);
        IResolver(res).grantSetterRoles(abi.encodeCall(IResolver.setText, (name, FRIENDS, "")), delegate);
        vm.prank(delegate);
        IResolver(res).setText(dns("other", "lortnoctahc", "eth"), FRIENDS, "junk");
        assertEq(_urText(name, FRIENDS), "", "handle's own record untouched");
    }

    function test_duressWipe_replacesClearRecords_linkToRecordZero_thenRestore() public {
        // 09-15: clearRecords(node) is GONE. linkToRecord(name, 0) unlinks the name from its record
        // (one tx, ROLE_LINK root-only) — the name then reads the (empty) default record. Records stay
        // in storage, so relinking to the old recordId restores them.
        (address res, bytes memory name) = _claimAlice();
        uint256 rid = IResolver(res).getRecordId(registrar.nodeOf("alice"));
        vm.prank(alice);
        IResolver(res).linkToRecord(name, 0);
        (address a,) = _urAddr(name);
        assertEq(a, address(0));
        assertEq(_urText(name, PUBKEY), "");
        vm.prank(alice);
        IResolver(res).linkToRecord(name, rid);
        (a,) = _urAddr(name);
        assertEq(a, alice);
        vm.prank(delegate);
        vm.expectRevert(); // ROLE_LINK is root-only
        IResolver(res).linkToRecord(name, 0);
    }

    function test_registryRootAdmin_canHijackHandles_untilEmancipated() public {
        // FLAG: the deployer holds ALL_ROLES on the LortnocRegistry root, and EAC ORs root into every
        // token check — so it can repoint (or unregister) ANY handle. Same as at 06-29.
        _claimAlice();
        uint256 tokenId = registry.findTokenId("alice");
        vm.prank(DEPLOYER);
        registry.setResolver(tokenId, address(0xdEaD));
        assertEq(registry.getResolver("alice"), address(0xdEaD));
        // Mitigation: drop RegistryRolesLib.UNEMANCIPATED_ROLE_BITMAP from the root admin.
        uint256 uneman = (1 << 20) | ((1 << 20) << 128) | (1 << 24) | ((1 << 24) << 128) | (1 << 12)
            | ((1 << 12) << 128) | (1 << 124) | ((1 << 124) << 128);
        vm.startPrank(DEPLOYER);
        registry.revokeRootRoles(uneman, DEPLOYER);
        assertTrue(registry.isEmancipated());
        vm.expectRevert();
        registry.setResolver(tokenId, address(0xbeef));
        vm.stopPrank();
        vm.prank(bob); // issuance still works: ROLE_REGISTRAR is not an unemancipated role
        registrar.claim("postemancip", "k");
        assertEq(registry.findOwner("postemancip"), bob);
    }

    // ---- relayed claim / migration ------------------------------------------------------------

    function test_claimFor_mintsToClaimant() public {
        vm.prank(relayer);
        (address res,) = registrar.claimFor("bob", "bb22", bob);
        bytes memory name = dns("bob", "lortnoctahc", "eth");
        assertEq(registry.findOwner("bob"), bob);
        assertEq(IResolver(res).roles(0, relayer), 0);
        (address a,) = _urAddr(name);
        assertEq(a, bob);
    }

    function test_claimFor_rejectsUnauthorized() public {
        vm.prank(alice);
        vm.expectRevert(LortnocRegistrar.NotRelayer.selector);
        registrar.claimFor("bob", "bb22", bob);
    }

    function test_migrate_carriesRecords_thenCloses() public {
        string[] memory k = new string[](2);
        string[] memory v = new string[](2);
        k[0] = "eth.lortnoc.knock";
        v[0] = '{"prompt":"bar?","salt":"s1","kdf":{"t":2}}';
        k[1] = "eth.lortnoc.discoverable";
        v[1] = "unlisted";
        vm.prank(DEPLOYER);
        registrar.migrate("kirsten", "cc33", alice, k, v);
        bytes memory name = dns("kirsten", "lortnoctahc", "eth");
        assertEq(_urText(name, "eth.lortnoc.knock"), v[0]);
        assertEq(_urText(name, PUBKEY), "cc33");
        assertEq(IUniversalHelper(UNIVERSAL_HELPER).findExactOwner(name), alice);

        vm.prank(alice);
        vm.expectRevert(LortnocRegistrar.NotOwner.selector);
        registrar.migrate("kevin", "dd", alice, new string[](0), new string[](0));

        string[] memory bad = new string[](1);
        bad[0] = PUBKEY;
        vm.prank(DEPLOYER);
        vm.expectRevert(abi.encodeWithSelector(LortnocRegistrar.ReservedKey.selector, PUBKEY));
        registrar.migrate("kevin", "dd", alice, bad, new string[](1));

        vm.startPrank(DEPLOYER);
        registrar.closeMigration();
        vm.expectRevert(LortnocRegistrar.MigrationIsClosed.selector);
        registrar.migrate("kevin", "dd", alice, new string[](0), new string[](0));
        vm.stopPrank();
    }

    // ---- lifecycle ---------------------------------------------------------------------------

    function test_takenLabelReverts() public {
        _claimAlice();
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(LortnocRegistrar.LabelTaken.selector, "alice"));
        registrar.claim("alice", "zz");
    }

    function _renewParent(uint64 duration) internal {
        address payer = makeAddr("anyone-can-renew");
        uint256 price = IETHRegistrar(ETH_REGISTRAR).getRenewPrice("lortnoctahc", duration, MOCK_USDC);
        vm.startPrank(payer);
        IMockUSDC(MOCK_USDC).mint(payer, price);
        IMockUSDC(MOCK_USDC).approve(ETH_REGISTRAR, price);
        IETHRegistrar(ETH_REGISTRAR).renew(RenewData("lortnoctahc", duration, bytes32(0)), MOCK_USDC);
        vm.stopPrank();
        console2.log("parent renew price (USDC 6dp)", price);
    }

    function test_parentExpiry_killsEveryHandle_evenUnexpiredOnes() public {
        // FLAG: lortnoctahc.eth @09-15 expires 1821860340 (2027-09-25). Handles get now+365d, i.e.
        // they OUTLIVE the parent. The moment the parent lapses, every handle stops resolving.
        (, bytes memory name) = _claimAlice();
        vm.warp(1821860340 + 1);
        vm.expectRevert(); // ResolverNotFound — the whole subtree is gone from the canonical root
        IUR(CANONICAL_UR).resolve(name, abi.encodeCall(IRecordReads.addr, (bytes32(0))));
        assertEq(IUniversalHelper(UNIVERSAL_HELPER).findExactOwner(name), address(0));
    }

    function test_expiry_ownerVanishes_resolvesEmpty_labelReclaimable() public {
        _renewParent(365 days); // otherwise the parent lapses first (see test above)
        (address res1, bytes memory name) = _claimAlice();
        vm.warp(block.timestamp + 365 days + 1); // parent lortnoctahc.eth expires later (1821860340)
        assertEq(IUniversalHelper(UNIVERSAL_HELPER).findExactOwner(name), address(0), "expired => no owner");
        (address a, address used) = _urAddr(name);
        assertEq(a, address(0), "expired handle reads empty (parent fallback), does not revert");
        assertEq(used, address(parentResolver));
        // 06-29 contract used salt=node → this second claim would CREATE2-collide. Nonce fixes it.
        vm.prank(bob);
        (address res2,) = registrar.claim("alice", "new");
        assertTrue(res2 != res1);
        (a,) = _urAddr(name);
        assertEq(a, bob);
    }

    function test_handleIsNonTransferable() public {
        _claimAlice();
        uint256 tokenId = registry.findTokenId("alice");
        vm.prank(alice);
        vm.expectRevert();
        registry.unsafeTransfer(bob, tokenId, "");
        vm.prank(alice);
        vm.expectRevert();
        registry.safeTransferFrom(alice, bob, tokenId, 1, "");
    }

    function test_labelRules() public {
        vm.startPrank(alice);
        vm.expectRevert();
        registrar.claim("Al", "k");
        vm.expectRevert();
        registrar.claim("-bad", "k");
        vm.expectRevert(LortnocRegistrar.EmptyPubkey.selector);
        registrar.claim("okay", "");
        vm.stopPrank();
    }

    function test_gas_claim() public {
        vm.prank(alice);
        uint256 g = gasleft();
        registrar.claim("gasprobe", "a3f1c0ffee0000000000000000000000000000000000000000000000000000aa");
        console2.log("claim gas (in-EVM, excl. intrinsic)", g - gasleft());
    }
}
