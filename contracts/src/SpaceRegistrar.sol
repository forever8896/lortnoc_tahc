// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// SpaceRegistrar — issues `<label>.space.lortnoctahc.eth` on ENS v2 `sepolia-deployment-2026-09-15`.
// The interface contract is docs/PRD-universal.md §23.1; this is the LortnocRegistrar (09-15 port)
// pattern with space records instead of a pubkey. Fork-tested against the real bytecode in
// test/SpaceRegistrar.fork.t.sol (FORK_RPC=<sepolia rpc> forge test).

import {Grant, IPermissionedResolver, IVerifiableFactory, ILortnocRegistry} from "./LortnocRegistrar.sol";

/// @title SpaceRegistrar — relayed issuance of paid community spaces
/// @notice ONE transaction per space, relayer-only (the relayer has verified a `SpaceBought` event
///         on mainnet or Sepolia first, §23.2):
///           1. deploy the space's own PermissionedResolver proxy via the canonical VerifiableFactory,
///              INITIALIZED with the space owner as sole root admin, its initializer writing
///              `addr(60) = owner`, `eth.lortnoc.space.token = token`, `eth.lortnoc.space.bans = ""`;
///           2. register `<label>` in the SpaceRegistry (the UserRegistry behind
///              `space.lortnoctahc.eth`), owned by the space owner and pointing at that resolver.
///         The registrar never holds a role on any space resolver, not even for one transaction.
///         Moderators are the owner's business afterwards:
///         `grantSetterRoles(setText(name, "eth.lortnoc.space.bans", ""), moderator)`.
contract SpaceRegistrar {
    /// @dev EACBaseRolesLib.ALL_ROLES @09-15.
    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    /// @dev RegistryRolesLib @09-15: ROLE_SET_SUBREGISTRY (1<<20), ROLE_SET_RESOLVER (1<<24) + admins.
    ///      Same token roles as handles — no ROLE_CAN_TRANSFER_ADMIN, so a space is not transferable.
    ///      The owner key is generated per space by the extension (§23.3); moving a space is a
    ///      relayer re-issue, not a token transfer.
    uint256 internal constant OWNER_TOKEN_ROLES =
        (1 << 20) | ((1 << 20) << 128) | (1 << 24) | ((1 << 24) << 128);

    uint256 internal constant COIN_TYPE_ETH = 60;
    uint256 public constant MAX_TOKEN_LENGTH = 256;

    string public constant TOKEN_KEY = "eth.lortnoc.space.token";
    string public constant BANS_KEY = "eth.lortnoc.space.bans";
    uint64 public constant DURATION = 365 days;

    ILortnocRegistry public immutable REGISTRY;
    IVerifiableFactory public immutable FACTORY;
    address public immutable RESOLVER_IMPL;
    bytes32 public immutable PARENT_NODE;

    /// @dev DNS-encoded `space.lortnoctahc.eth` — 09-15 setters take the full DNS-encoded name.
    bytes public PARENT_DNS_NAME;

    address public owner;
    mapping(address relayer => bool allowed) public isRelayer;

    /// @dev Proxy salt nonce per node, so re-issuing an EXPIRED label never CREATE2-collides.
    mapping(bytes32 node => uint256 count) public claimCount;

    event SpaceClaimed(
        string label,
        address indexed spaceOwner,
        address indexed resolver,
        uint256 tokenId,
        bytes32 node,
        string token
    );
    event RelayerChanged(address indexed relayer, bool allowed);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotRelayer();
    error LabelTaken(string label);
    error InvalidLabel(string label);
    error TokenTooLong();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param parentDnsName DNS-encoded `space.lortnoctahc.eth`. PARENT_NODE is derived from it.
    constructor(
        ILortnocRegistry registry,
        IVerifiableFactory factory,
        address resolverImpl,
        bytes memory parentDnsName,
        address owner_
    ) {
        if (
            address(registry) == address(0) ||
            address(factory) == address(0) ||
            resolverImpl == address(0) ||
            owner_ == address(0)
        ) revert ZeroAddress();
        REGISTRY = registry;
        FACTORY = factory;
        RESOLVER_IMPL = resolverImpl;
        PARENT_DNS_NAME = parentDnsName;
        PARENT_NODE = _namehash(parentDnsName, 0);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---- issuance ------------------------------------------------------------------------------

    /// @notice Create `<label>.space.lortnoctahc.eth` for `spaceOwner`.
    /// @param token CAIP-19 collection that gates readers, e.g. `eip155:11155111/erc721:0xabc…`;
    ///        empty = no token gate. The relayer checked it against the purchase's `rulesHash`.
    function claimSpaceFor(string calldata label, address spaceOwner, string calldata token)
        external
        returns (address resolver, uint256 tokenId)
    {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        if (spaceOwner == address(0)) revert ZeroAddress();
        if (!validLabel(label)) revert InvalidLabel(label);
        if (bytes(token).length > MAX_TOKEN_LENGTH) revert TokenTooLong();
        if (REGISTRY.findOwner(label) != address(0)) revert LabelTaken(label);

        bytes32 node = keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
        bytes memory name = abi.encodePacked(uint8(bytes(label).length), label, PARENT_DNS_NAME);

        // Written by the initializer's unchecked `calls` (09-15), so nobody but the owner ever
        // holds a role on this resolver.
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(
            IPermissionedResolver.setAddress, (name, COIN_TYPE_ETH, abi.encodePacked(spaceOwner))
        );
        calls[1] = abi.encodeCall(IPermissionedResolver.setText, (name, TOKEN_KEY, token));
        calls[2] = abi.encodeCall(IPermissionedResolver.setText, (name, BANS_KEY, ""));
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(spaceOwner, ALL_ROLES);

        resolver = FACTORY.deployProxy(
            RESOLVER_IMPL,
            predictSalt(node, claimCount[node]++),
            abi.encodeCall(IPermissionedResolver.initialize, (grants, calls))
        );

        tokenId = REGISTRY.register(
            label,
            spaceOwner,
            address(0),
            resolver,
            OWNER_TOKEN_ROLES,
            uint64(block.timestamp) + DURATION
        );

        emit SpaceClaimed(label, spaceOwner, resolver, tokenId, node, token);
    }

    // ---- views ---------------------------------------------------------------------------------

    function available(string calldata label) external view returns (bool) {
        if (!validLabel(label)) return false;
        return REGISTRY.findOwner(label) == address(0);
    }

    function nodeOf(string calldata label) external view returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
    }

    /// @notice DNS-encoded `<label>.space.lortnoctahc.eth` — the `name` every 09-15 setter takes.
    function dnsNameOf(string calldata label) external view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, PARENT_DNS_NAME);
    }

    function predictSalt(bytes32 node, uint256 n) public pure returns (uint256) {
        return n == 0 ? uint256(node) : uint256(keccak256(abi.encode(node, n)));
    }

    /// @notice Same rule as LortnocSpaces.validLabel: ^[a-z0-9-]{3,32}$, no leading/trailing '-'.
    ///         Identical on purpose — a purchase can never succeed for a name we would refuse.
    function validLabel(string calldata label) public pure returns (bool) {
        bytes calldata b = bytes(label);
        if (b.length < 3 || b.length > 32) return false;
        if (b[0] == "-" || b[b.length - 1] == "-") return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            if (!((c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-")) return false;
        }
        return true;
    }

    /// @dev ENSIP-1 namehash of a DNS-encoded name.
    function _namehash(bytes memory name, uint256 offset) internal pure returns (bytes32) {
        uint256 len = uint8(name[offset]);
        if (len == 0) return bytes32(0);
        bytes memory label = new bytes(len);
        for (uint256 i; i < len; ++i) label[i] = name[offset + 1 + i];
        return keccak256(abi.encodePacked(_namehash(name, offset + 1 + len), keccak256(label)));
    }

    // ---- admin ---------------------------------------------------------------------------------

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        isRelayer[relayer] = allowed;
        emit RelayerChanged(relayer, allowed);
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, to);
        owner = to;
    }
}
