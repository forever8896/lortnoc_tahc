// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// LortnocRegistrar for ENS v2 `sepolia-deployment-2026-09-15` (ported from the 06-29 version).
// Every API difference vs the 06-29 version is marked `// 09-15:`. Fork-tested against the real
// bytecode in test/LortnocRegistrar.fork.t.sol (FORK_RPC=<sepolia rpc> forge test).

/// @dev 09-15: `Grant` struct from access-control/interfaces/IEACGrantInitializable.sol.
struct Grant {
    address account;
    uint256 roleBitmap;
}

/// @notice Per-user resolver: `PermissionedResolverImpl` @09-15 behind a VerifiableFactory proxy.
interface IPermissionedResolver {
    // 09-15: was initialize(address admin, uint256 roleBitmap, bytes[] setters). `calls` now run
    //        WITHOUT permission checks while initializing (PermissionedResolver.sol:119-126,370-378).
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
    // 09-15: was setText(bytes32 node, ...). Setters take the DNS-encoded NAME.
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    // 09-15: was setAddr(bytes32 node, address). Now ENSIP-9/11 bytes, coinType 60 = ETH.
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
}

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data)
        external
        returns (address);
    function verifyContract(address proxy) external view returns (address);
}

/// @notice The `UserRegistry` proxy slotted under `lortnoctahc.eth`. `register` is unchanged at 09-15.
interface ILortnocRegistry {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256);

    function findOwner(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface INullifierGate {
    function spend(bytes32 nullifier, address claimant) external;
}

/// @title LortnocRegistrar (09-15 port) — permissionless issuance of `<label>.lortnoctahc.eth`
/// @notice ONE transaction per claim, as before:
///           1. deploy a per-handle PermissionedResolver proxy via the canonical VerifiableFactory,
///              INITIALIZED with the claimant as sole root admin and the pubkey + addr records
///              written by the initializer's unchecked `calls`;
///           2. register the subname in LortnocRegistry, pointing at that resolver.
///
///         09-15 simplification: the old "grant ourselves ALL_ROLES → write → grant claimant →
///         revoke ourselves" dance is gone. The registrar is never a role holder on any handle
///         resolver, not even for one transaction.
contract LortnocRegistrar {
    /// @dev EACBaseRolesLib.ALL_ROLES — unchanged at 09-15.
    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    /// @dev RegistryRolesLib @09-15: ROLE_SET_SUBREGISTRY (1<<20), ROLE_SET_RESOLVER (1<<24) + admins.
    ///      Deliberately NOT ROLE_CAN_TRANSFER_ADMIN ((1<<28)<<128): handles stay non-transferable,
    ///      because the owner is K_own derived from MS (CLAUDE.md §5.1) and a transfer would detach
    ///      the handle from the identity that publishes its pubkey.
    uint256 internal constant OWNER_TOKEN_ROLES =
        (1 << 20) | ((1 << 20) << 128) | (1 << 24) | ((1 << 24) << 128);

    uint256 internal constant COIN_TYPE_ETH = 60;

    ILortnocRegistry public immutable REGISTRY;
    IVerifiableFactory public immutable FACTORY;
    address public immutable RESOLVER_IMPL;
    bytes32 public immutable PARENT_NODE;

    /// @dev 09-15: setters need the DNS-encoded name, so we keep the parent's wire form.
    bytes public PARENT_DNS_NAME;

    string public constant PUBKEY_KEY = "eth.lortnoc.pubkey";
    uint64 public constant DURATION = 365 days;

    address public owner;
    INullifierGate public gate;
    mapping(address relayer => bool allowed) public isRelayer;

    /// @dev Proxy salt nonce per node. The 06-29 contract used `salt = node`, so re-claiming an
    ///      EXPIRED label would CREATE2-collide and revert forever. A per-node counter fixes that
    ///      while keeping the address predictable (`predictSalt`).
    mapping(bytes32 node => uint256 count) public claimCount;

    /// @dev One-shot reissue window for handles from the dead 06-29 deployment. Closed forever by
    ///      `closeMigration()`.
    bool public migrationOpen = true;

    event HandleClaimed(
        string label,
        address indexed claimant,
        address indexed resolver,
        uint256 tokenId,
        bytes32 node
    );
    event HandleMigrated(string label, address indexed claimant, uint256 records);
    event MigrationClosed();
    event GateChanged(address indexed gate);
    event RelayerChanged(address indexed relayer, bool allowed);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotRelayer();
    error GateNotSet();
    error GateIsSet();
    error LabelTaken(string label);
    error InvalidLabel(string label);
    error EmptyPubkey();
    error ZeroAddress();
    error MigrationIsClosed();
    error LengthMismatch();
    error ReservedKey(string key);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param parentDnsName DNS-encoded `lortnoctahc.eth` (0x0b6c6f72746e6f637461686303657468 00).
    ///        PARENT_NODE is derived from it on-chain, so the two can never disagree.
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

    // ---- claiming (external surface unchanged vs 06-29) ---------------------------------------

    function claim(string calldata label, string calldata pubkey)
        external
        returns (address resolver, uint256 tokenId)
    {
        if (address(gate) != address(0)) revert GateIsSet();
        return _claim(label, pubkey, msg.sender, new string[](0), new string[](0));
    }

    function claimWithProof(string calldata label, string calldata pubkey, bytes32 nullifier)
        external
        returns (address resolver, uint256 tokenId)
    {
        INullifierGate g = gate;
        if (address(g) == address(0)) revert GateNotSet();
        g.spend(nullifier, msg.sender);
        return _claim(label, pubkey, msg.sender, new string[](0), new string[](0));
    }

    function claimFor(string calldata label, string calldata pubkey, address claimant)
        external
        returns (address resolver, uint256 tokenId)
    {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        if (claimant == address(0)) revert ZeroAddress();
        return _claim(label, pubkey, claimant, new string[](0), new string[](0));
    }

    /// @notice Reissue a handle from the 06-29 deployment to its SAME owner (their K_own address),
    ///         carrying its public text records verbatim (e.g. `eth.lortnoc.knock`, whose salt must
    ///         not change or pending knocks become unopenable — CLAUDE.md §6.8 fix #2).
    ///         Owner-only and one-shot: after `closeMigration()` this path is dead.
    /// @dev Grants nothing to anyone but `claimant`; `addr` is always the claimant (never copied).
    function migrate(
        string calldata label,
        string calldata pubkey,
        address claimant,
        string[] calldata keys,
        string[] calldata values
    ) external onlyOwner returns (address resolver, uint256 tokenId) {
        if (!migrationOpen) revert MigrationIsClosed();
        if (claimant == address(0)) revert ZeroAddress();
        if (keys.length != values.length) revert LengthMismatch();
        for (uint256 i; i < keys.length; ++i) {
            if (keccak256(bytes(keys[i])) == keccak256(bytes(PUBKEY_KEY))) revert ReservedKey(keys[i]);
        }
        (resolver, tokenId) = _claim(label, pubkey, claimant, keys, values);
        emit HandleMigrated(label, claimant, keys.length);
    }

    function closeMigration() external onlyOwner {
        migrationOpen = false;
        emit MigrationClosed();
    }

    function _claim(
        string calldata label,
        string calldata pubkey,
        address claimant,
        string[] memory keys,
        string[] memory values
    ) internal returns (address resolver, uint256 tokenId) {
        _requireValidLabel(label);
        if (bytes(pubkey).length == 0) revert EmptyPubkey();
        if (REGISTRY.findOwner(label) != address(0)) revert LabelTaken(label);

        bytes32 node = keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
        bytes memory name = abi.encodePacked(uint8(bytes(label).length), label, PARENT_DNS_NAME);

        // 09-15: records are written by the initializer. `_checkRoles` is skipped while
        // `_isInitializing()`, so the factory (msg.sender during init) needs no roles and this
        // contract is never granted any.
        bytes[] memory calls = new bytes[](2 + keys.length);
        calls[0] = abi.encodeCall(IPermissionedResolver.setText, (name, PUBKEY_KEY, pubkey));
        calls[1] = abi.encodeCall(
            IPermissionedResolver.setAddress, (name, COIN_TYPE_ETH, abi.encodePacked(claimant))
        );
        for (uint256 i; i < keys.length; ++i) {
            calls[2 + i] = abi.encodeCall(IPermissionedResolver.setText, (name, keys[i], values[i]));
        }
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(claimant, ALL_ROLES);

        resolver = FACTORY.deployProxy(
            RESOLVER_IMPL,
            predictSalt(node, claimCount[node]++),
            abi.encodeCall(IPermissionedResolver.initialize, (grants, calls))
        );

        tokenId = REGISTRY.register(
            label,
            claimant,
            address(0),
            resolver,
            OWNER_TOKEN_ROLES,
            uint64(block.timestamp) + DURATION
        );

        emit HandleClaimed(label, claimant, resolver, tokenId, node);
    }

    // ---- views -------------------------------------------------------------------------------

    function available(string calldata label) external view returns (bool) {
        if (!_isValidLabel(label)) return false;
        return REGISTRY.findOwner(label) == address(0);
    }

    function nodeOf(string calldata label) external view returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
    }

    /// @notice DNS-encoded `<label>.lortnoctahc.eth` — the `name` argument every 09-15 setter takes.
    function dnsNameOf(string calldata label) external view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, PARENT_DNS_NAME);
    }

    function predictSalt(bytes32 node, uint256 n) public pure returns (uint256) {
        return n == 0 ? uint256(node) : uint256(keccak256(abi.encode(node, n)));
    }

    // ---- label rules (unchanged) --------------------------------------------------------------

    function _isValidLabel(string calldata label) internal pure returns (bool) {
        bytes calldata b = bytes(label);
        if (b.length < 3 || b.length > 32) return false;
        if (b[0] == "-" || b[b.length - 1] == "-") return false;
        for (uint256 i; i < b.length; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) return false;
        }
        return true;
    }

    function _requireValidLabel(string calldata label) internal pure {
        if (!_isValidLabel(label)) revert InvalidLabel(label);
    }

    /// @dev ENSIP-1 namehash of a DNS-encoded name.
    function _namehash(bytes memory name, uint256 offset) internal pure returns (bytes32) {
        uint256 len = uint8(name[offset]);
        if (len == 0) return bytes32(0);
        bytes memory label = new bytes(len);
        for (uint256 i; i < len; ++i) label[i] = name[offset + 1 + i];
        return keccak256(abi.encodePacked(_namehash(name, offset + 1 + len), keccak256(label)));
    }

    // ---- admin (unchanged) --------------------------------------------------------------------

    function setGate(INullifierGate gate_) external onlyOwner {
        gate = gate_;
        emit GateChanged(address(gate_));
    }

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
