// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Per-user resolver: `PermissionedResolverImpl` behind a VerifiableFactory proxy.
interface IPermissionedResolver {
    function initialize(address admin, uint256 roleBitmap, bytes[] calldata setters) external;
    function setText(bytes32 node, string calldata key, string calldata value) external;
    function setAddr(bytes32 node, address addr) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

/// @notice CREATE2 proxy factory. `outerSalt = keccak256(msg.sender, salt)`, so this contract's
///         proxies are deterministic and `verifyContract(proxy)` returns the implementation.
interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data)
        external
        returns (address);
    function verifyContract(address proxy) external view returns (address);
}

/// @notice The `UserRegistry` proxy slotted under `lortnoctahc.eth`.
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

/// @notice Optional paid-tier gate (§7). Reverts if the nullifier is spent or the proof is bad.
interface INullifierGate {
    function spend(bytes32 nullifier, address claimant) external;
}

/// @title LortnocRegistrar — permissionless issuance of `<label>.lortnoctahc.eth` on ENS v2
/// @notice Holds `ROLE_REGISTRAR` on the LortnocRegistry and hands out subnames to anyone, in ONE
///         transaction that also gives the claimant their own Permissioned Resolver.
///
///         `claim()` does five things atomically (CLAUDE.md §6.5 build order, steps 2 + 4):
///           1. deploy a per-handle `PermissionedResolver` proxy via the canonical
///              `VerifiableFactory` — so `verifyContract(proxy)` is a trustless handle proof;
///           2. write `eth.lortnoc.pubkey` on it (the X25519 messaging key, §5.4);
///           3. grant the claimant every root role on that resolver;
///           4. revoke this contract's own roles — we are admin for one transaction only;
///           5. register the subname in the registry, pointing at that resolver.
///
///         Afterwards this contract has NO authority over the handle or its records. The user is
///         the sole admin of their own resolver proxy and can `authorizeTextRoles` a gateway onto
///         exactly one text key, then revoke it — the ENS v2 flagship demo.
///
/// @dev Paid tier (§7): point `gate` at a nullifier registry and claims must present an unspent
///      Semaphore nullifier via `claimWithProof`. Unset = the free tier, which is intentionally
///      non-anonymous (§8/§9). Relayed claims (`claimFor`) keep payer ≠ claimer, so payment stays
///      unlinkable to the handle (§8 Layer 1).
contract LortnocRegistrar {
    ////////////////////////////////////////////////////////////////////////
    // Role constants (verbatim from the pinned ENS v2 deployment)
    ////////////////////////////////////////////////////////////////////////

    /// @dev `EACBaseRolesLib.ALL_ROLES` — bit 0 of every nybble: one unit in each of the 64 role
    ///      slots (32 regular + 32 admin). Granting this makes the claimant full admin of their
    ///      own resolver, including `ROLE_SET_ALIAS` (root-only) and `ROLE_UPGRADE`.
    uint256 internal constant ALL_ROLES =
        0x1111111111111111111111111111111111111111111111111111111111111111;

    /// @dev `RegistryRolesLib.ROLE_SET_SUBREGISTRY` (1<<20) and `ROLE_SET_RESOLVER` (1<<24) plus
    ///      their admin variants (role<<128). What the handle owner gets on their own subname:
    ///      they may repoint their resolver or nest a subregistry, and delegate either.
    uint256 internal constant OWNER_TOKEN_ROLES =
        (1 << 20) | ((1 << 20) << 128) | (1 << 24) | ((1 << 24) << 128);

    ////////////////////////////////////////////////////////////////////////
    // Immutables
    ////////////////////////////////////////////////////////////////////////

    ILortnocRegistry public immutable REGISTRY;
    IVerifiableFactory public immutable FACTORY;
    address public immutable RESOLVER_IMPL;

    /// @dev `namehash("lortnoctahc.eth")`. Subname nodes are derived from it, so the resolver
    ///      records this contract writes are keyed to the name the registry actually serves.
    bytes32 public immutable PARENT_NODE;

    /// @dev The messaging pubkey text record (§5.4). `lortnoc.eth` is registered to the same
    ///      owner, so this namespace is a name we control.
    string public constant PUBKEY_KEY = "eth.lortnoc.pubkey";

    /// @dev Subname term. Renewal is out of scope for the hackathon build.
    uint64 public constant DURATION = 365 days;

    ////////////////////////////////////////////////////////////////////////
    // Storage
    ////////////////////////////////////////////////////////////////////////

    address public owner;

    /// @dev Unset = free tier, `claim()` open to all. Set = paid tier, `claimWithProof()` only.
    INullifierGate public gate;

    /// @dev Addresses allowed to claim on someone else's behalf (payer ≠ claimer, §8 Layer 1).
    mapping(address relayer => bool allowed) public isRelayer;

    ////////////////////////////////////////////////////////////////////////
    // Events & errors
    ////////////////////////////////////////////////////////////////////////

    event HandleClaimed(
        string label,
        address indexed claimant,
        address indexed resolver,
        uint256 tokenId,
        bytes32 node
    );
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

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        ILortnocRegistry registry,
        IVerifiableFactory factory,
        address resolverImpl,
        bytes32 parentNode,
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
        PARENT_NODE = parentNode;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    ////////////////////////////////////////////////////////////////////////
    // Claiming
    ////////////////////////////////////////////////////////////////////////

    /// @notice Claim `<label>.lortnoctahc.eth` for yourself. Free tier — open while `gate` is unset.
    /// @param label The handle, 3-32 chars of [a-z0-9-], no leading/trailing hyphen.
    /// @param pubkey Hex-encoded X25519 messaging pubkey, written to `eth.lortnoc.pubkey`.
    function claim(string calldata label, string calldata pubkey)
        external
        returns (address resolver, uint256 tokenId)
    {
        if (address(gate) != address(0)) revert GateIsSet();
        return _claim(label, pubkey, msg.sender);
    }

    /// @notice Paid tier (§7): claim by spending an unspent membership nullifier. The gate never
    ///         learns which payment the nullifier came from — that is the whole point.
    function claimWithProof(string calldata label, string calldata pubkey, bytes32 nullifier)
        external
        returns (address resolver, uint256 tokenId)
    {
        INullifierGate g = gate;
        if (address(g) == address(0)) revert GateNotSet();
        g.spend(nullifier, msg.sender);
        return _claim(label, pubkey, msg.sender);
    }

    /// @notice Relayed claim: an authorized relayer pays the gas, `claimant` owns the handle.
    ///         Keeps the funding wallet off the handle (§4 identity wallet ≠ payment wallet).
    function claimFor(string calldata label, string calldata pubkey, address claimant)
        external
        returns (address resolver, uint256 tokenId)
    {
        if (!isRelayer[msg.sender]) revert NotRelayer();
        if (claimant == address(0)) revert ZeroAddress();
        return _claim(label, pubkey, claimant);
    }

    function _claim(string calldata label, string calldata pubkey, address claimant)
        internal
        returns (address resolver, uint256 tokenId)
    {
        _requireValidLabel(label);
        if (bytes(pubkey).length == 0) revert EmptyPubkey();
        if (REGISTRY.findOwner(label) != address(0)) revert LabelTaken(label);

        bytes32 node = keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));

        // 1. Per-handle resolver proxy from the canonical factory. Salt is the node, so the
        //    address is deterministic and predictable from the label alone.
        //    `setters` is empty on purpose: during `initialize` the caller is the factory, which
        //    holds no roles, so an inlined `setText` would revert. We write it in step 2 instead.
        resolver = FACTORY.deployProxy(
            RESOLVER_IMPL,
            uint256(node),
            abi.encodeCall(
                IPermissionedResolver.initialize,
                (address(this), ALL_ROLES, new bytes[](0))
            )
        );

        IPermissionedResolver r = IPermissionedResolver(resolver);

        // 2. Publish the messaging pubkey while we still hold roles — and the ETH address.
        //
        //    `addr` matters more than it looks: it is the record every ENS explorer and wallet
        //    asks for first. Writing only the custom text key left every handle resolving to
        //    0x0, so tooling reported our names as not resolving at all even though the resolver
        //    was correctly linked and the text record read back fine. It must be written here,
        //    in this transaction, because step 4 drops the only authority we ever hold.
        r.setText(node, PUBKEY_KEY, pubkey);
        r.setAddr(node, claimant);

        // 3-4. Hand the resolver over, then drop our own authority. Order matters: EAC forbids
        //      removing the last assignee of a role, so grant before revoking.
        r.grantRootRoles(ALL_ROLES, claimant);
        r.revokeRootRoles(ALL_ROLES, address(this));

        // 5. Issue the subname pointing at that resolver. Needs `ROLE_REGISTRAR` on the registry
        //    root, which this contract holds and users do not — that is why claiming goes
        //    through here rather than straight to the registry.
        tokenId = REGISTRY.register(
            label,
            claimant,
            address(0), // no nested subregistry
            resolver,
            OWNER_TOKEN_ROLES,
            uint64(block.timestamp) + DURATION
        );

        emit HandleClaimed(label, claimant, resolver, tokenId, node);
    }

    ////////////////////////////////////////////////////////////////////////
    // Views
    ////////////////////////////////////////////////////////////////////////

    /// @notice Whether `label` can be claimed right now (valid shape + not taken).
    function available(string calldata label) external view returns (bool) {
        if (!_isValidLabel(label)) return false;
        return REGISTRY.findOwner(label) == address(0);
    }

    /// @notice `namehash("<label>.lortnoctahc.eth")` — the node its records live under.
    function nodeOf(string calldata label) external view returns (bytes32) {
        return keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
    }

    ////////////////////////////////////////////////////////////////////////
    // Label rules
    ////////////////////////////////////////////////////////////////////////

    /// @dev Deliberately narrow: lowercase ASCII only, so a handle cannot be homograph-spoofed
    ///      and normalizes identically everywhere (UI, contract, ENS name-hashing).
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

    ////////////////////////////////////////////////////////////////////////
    // Admin
    ////////////////////////////////////////////////////////////////////////

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
