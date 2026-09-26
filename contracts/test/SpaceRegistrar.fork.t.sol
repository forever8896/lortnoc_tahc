// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// FORK test: SpaceRegistrar against the REAL ENS v2 `sepolia-deployment-2026-09-15` bytecode AND
// our LIVE LortnocRegistry (0x836F…8b24). It builds the `space.lortnoctahc.eth` branch exactly as
// scripts/ens/deploy-spaces-branch.mjs does, then checks everything through the canonical path.
//   FORK_RPC=https://ethereum-sepolia-rpc.publicnode.com forge test --root contracts --match-contract SpaceRegistrarFork -vv
// Skipped when FORK_RPC is unset. The deployer is impersonated; no key is read, nothing broadcast.

import {Test} from "forge-std/Test.sol";
import {SpaceRegistrar} from "../src/SpaceRegistrar.sol";
import {LortnocRegistrar, Grant, ILortnocRegistry, IVerifiableFactory} from "../src/LortnocRegistrar.sol";

interface IUserRegistryF {
    function initialize(Grant[] calldata grants) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function setParent(address parent, string calldata label) external;
    function findOwner(string calldata label) external view returns (address);
    function findTokenId(string calldata label) external view returns (uint256);
    function getResolver(string calldata label) external view returns (address);
    function getSubregistry(string calldata label) external view returns (address);
    function register(string calldata, address, address, address, uint256, uint64) external returns (uint256);
    function unsafeTransfer(address to, uint256 tokenId, bytes calldata data) external;
}

interface IResolverF {
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata a) external;
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function roles(uint256 resource, address account) external view returns (uint256);
    function supportsInterface(bytes4) external view returns (bool);
}

interface IURF {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

interface IHelperF {
    function findExactOwner(bytes calldata name) external view returns (address);
}

interface IReadsF {
    function addr(bytes32 node) external view returns (address);
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

contract SpaceRegistrarForkTest is Test {
    address constant FACTORY = 0x9e726Eb570beb6BCEb495AB8cdA7df517d4e841C;
    address constant RESOLVER_IMPL = 0x14F09Fd05d4585759e54844DC9B00147131Cf243;
    address constant USER_REGISTRY_IMPL = 0xA80338aAA8D23831cEa25E858D1774534aBb0263;
    address constant CANONICAL_UR = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    address constant UNIVERSAL_HELPER = 0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5;
    address constant DEPLOYER = 0x61eE2fBcf2841d9094e2D42406Dd4f83a7981Bb8;
    // LIVE (ens-deployment.json lortnoc.*)
    address constant LORTNOC_REGISTRY = 0x836FEEa0f638b9816a24a7D305bdf0Ee2d0C8b24;
    address constant LORTNOC_REGISTRAR = 0xBFC809D604C1f262Fd46A2E689B350350D3f2E14;

    uint256 constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
    uint256 constant ROLE_REGISTRAR = 1;
    uint256 constant ROLE_SET_TEXT = 1 << 4;
    uint256 constant OWNER_TOKEN_ROLES = (1 << 20) | ((1 << 20) << 128) | (1 << 24) | ((1 << 24) << 128);

    string constant TOKEN_KEY = "eth.lortnoc.space.token";
    string constant BANS_KEY = "eth.lortnoc.space.bans";
    string constant TOKEN = "eip155:11155111/erc721:0x00000000000000000000000000000000000000aa";

    IUserRegistryF spaceRegistry;
    IResolverF spaceResolver;
    SpaceRegistrar registrar;
    bytes spaceDns;

    address owner = makeAddr("space-owner");
    address mod = makeAddr("moderator");
    address relayer = makeAddr("relayer");

    function _dns(string memory label) internal view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, spaceDns);
    }

    function setUp() public {
        if (!vm.envExists("FORK_RPC")) {
            vm.skip(true, "FORK_RPC unset");
            return;
        }
        vm.createSelectFork(vm.envString("FORK_RPC"), 11_783_287); // live 09-15 LortnocRegistry, no `space` yet
        spaceDns = abi.encodePacked(uint8(5), "space", uint8(11), "lortnoctahc", uint8(3), "eth", uint8(0));
        assertEq(IUserRegistryF(LORTNOC_REGISTRY).findOwner("space"), address(0), "fork: `space` must be free");

        vm.startPrank(DEPLOYER);
        Grant[] memory g = new Grant[](1);
        g[0] = Grant(DEPLOYER, ALL_ROLES);
        spaceRegistry = IUserRegistryF(
            IVerifiableFactory(FACTORY).deployProxy(
                USER_REGISTRY_IMPL, uint256(keccak256("lortnoc/space-registry/test")), abi.encodeCall(IUserRegistryF.initialize, (g))
            )
        );
        spaceRegistry.setParent(LORTNOC_REGISTRY, "space");

        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(IResolverF.setAddress, (spaceDns, 60, abi.encodePacked(DEPLOYER)));
        spaceResolver = IResolverF(
            IVerifiableFactory(FACTORY).deployProxy(
                RESOLVER_IMPL, uint256(keccak256("lortnoc/space-resolver/test")), abi.encodeCall(IResolverF.initialize, (g, calls))
            )
        );
        // The deployer holds ALL_ROLES on LortnocRegistry's root, which includes ROLE_REGISTRAR.
        IUserRegistryF(LORTNOC_REGISTRY).register(
            "space", DEPLOYER, address(spaceRegistry), address(spaceResolver), OWNER_TOKEN_ROLES, uint64(block.timestamp + 5 * 365 days)
        );

        registrar = new SpaceRegistrar(
            ILortnocRegistry(address(spaceRegistry)), IVerifiableFactory(FACTORY), RESOLVER_IMPL, spaceDns, DEPLOYER
        );
        spaceRegistry.grantRootRoles(ROLE_REGISTRAR, address(registrar));
        registrar.setRelayer(relayer, true);
        vm.stopPrank();
    }

    function _urAddr(bytes memory name) internal view returns (address a, address used) {
        (bytes memory r, address res) = IURF(CANONICAL_UR).resolve(name, abi.encodeCall(IReadsF.addr, (bytes32(0))));
        return (abi.decode(r, (address)), res);
    }

    function _urText(bytes memory name, string memory key) internal view returns (string memory) {
        (bytes memory r,) = IURF(CANONICAL_UR).resolve(name, abi.encodeCall(IReadsF.text, (bytes32(0), key)));
        return abi.decode(r, (string));
    }

    function _claim() internal returns (address res, bytes memory name) {
        vm.prank(relayer);
        (res,) = registrar.claimSpaceFor("lentil-club", owner, TOKEN);
        name = _dns("lentil-club");
    }

    function test_branch_resolvesThroughCanonicalUR() public view {
        (address a, address used) = _urAddr(spaceDns);
        assertEq(a, DEPLOYER);
        assertEq(used, address(spaceResolver));
        assertTrue(spaceResolver.supportsInterface(0x9061b923), "IExtendedResolver (fix #440)");
        assertEq(IHelperF(UNIVERSAL_HELPER).findExactOwner(spaceDns), DEPLOYER);
    }

    function test_branch_labelNoLongerClaimableAsHandle() public {
        vm.expectRevert(abi.encodeWithSelector(LortnocRegistrar.LabelTaken.selector, "space"));
        LortnocRegistrar(LORTNOC_REGISTRAR).claim("space", "k");
    }

    function test_claim_canonicalPath() public {
        (address res, bytes memory name) = _claim();
        (address a, address used) = _urAddr(name);
        assertEq(a, owner, "addr(60) == owner");
        assertEq(used, res, "UR uses the space's own resolver");
        assertEq(_urText(name, TOKEN_KEY), TOKEN);
        assertEq(_urText(name, BANS_KEY), "");
        assertEq(IHelperF(UNIVERSAL_HELPER).findExactOwner(name), owner, "registry owner == space owner");
        assertEq(IVerifiableFactory(FACTORY).verifyContract(res), RESOLVER_IMPL);
    }

    function test_claim_registrarAndRelayerHoldNoRole() public {
        (address res,) = _claim();
        assertEq(IResolverF(res).roles(0, address(registrar)), 0);
        assertEq(IResolverF(res).roles(0, relayer), 0);
        assertEq(IResolverF(res).roles(0, FACTORY), 0);
        assertEq(IResolverF(res).roles(0, owner), ALL_ROLES);
    }

    function test_moderator_bansOnly_thenRevoke() public {
        (address res, bytes memory name) = _claim();
        IResolverF r = IResolverF(res);
        vm.prank(owner);
        r.setText(name, BANS_KEY, "member-aaaaaaaaaaaa");
        assertEq(_urText(name, BANS_KEY), "member-aaaaaaaaaaaa");

        vm.prank(owner);
        r.grantSetterRoles(abi.encodeCall(IResolverF.setText, (name, BANS_KEY, "")), mod);
        vm.prank(mod);
        r.setText(name, BANS_KEY, "member-aaaaaaaaaaaa,member-bbbbbbbbbbbb");
        assertEq(_urText(name, BANS_KEY), "member-aaaaaaaaaaaa,member-bbbbbbbbbbbb");

        vm.startPrank(mod);
        vm.expectRevert();
        r.setText(name, TOKEN_KEY, "eip155:1/erc721:0x0000000000000000000000000000000000000bad");
        vm.expectRevert();
        r.setAddress(name, 60, abi.encodePacked(mod));
        vm.stopPrank();

        vm.prank(owner);
        r.revokeRoles(uint256(keccak256(bytes(BANS_KEY))), ROLE_SET_TEXT, mod);
        vm.prank(mod);
        vm.expectRevert();
        r.setText(name, BANS_KEY, "");
        assertEq(_urText(name, TOKEN_KEY), TOKEN);
    }

    function test_unclaimedSpace_readsEmpty_noOwner() public view {
        bytes memory ghost = _dns("ghost-space");
        (address a, address used) = _urAddr(ghost);
        assertEq(a, address(0));
        assertEq(used, address(spaceResolver), "falls back to the branch resolver, empty");
        assertEq(IHelperF(UNIVERSAL_HELPER).findExactOwner(ghost), address(0));
        assertTrue(registrar.available("ghost-space"));
    }

    function test_takenReverts_andSpaceIsNonTransferable() public {
        _claim();
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(SpaceRegistrar.LabelTaken.selector, "lentil-club"));
        registrar.claimSpaceFor("lentil-club", mod, "");
        uint256 id = spaceRegistry.findTokenId("lentil-club");
        vm.prank(owner);
        vm.expectRevert();
        spaceRegistry.unsafeTransfer(mod, id, "");
    }

    function test_onlyRelayer() public {
        vm.prank(DEPLOYER);
        vm.expectRevert(SpaceRegistrar.NotRelayer.selector);
        registrar.claimSpaceFor("lentil-club", owner, TOKEN);
    }
}
