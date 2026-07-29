// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stand-ins for the pinned ENS v2 Sepolia deployment, faithful to the parts
///         LortnocRegistrar depends on and no further.
///
/// @dev The behaviour these mocks reproduce deliberately includes the AWKWARD parts, because
///      those are where the registrar's ordering constraints come from:
///
///        * MockPermissionedResolver enforces roles on writes, so a test can prove the registrar
///          really does drop its own authority in step 4 — a resolver that accepted every write
///          would make that assertion vacuous.
///        * It also refuses to remove the last assignee of a role, mirroring EAC. That is the
///          reason `_claim` must grant to the claimant BEFORE revoking from itself, and the
///          reason a naive reordering would revert rather than silently leave the registrar in
///          control.

/// @dev Mirrors `PermissionedResolverImpl` closely enough to test the role handover.
contract MockPermissionedResolver {
    mapping(address account => uint256 roles) public roles;
    mapping(bytes32 node => mapping(string key => string value)) public text;
    mapping(bytes32 node => address) public addr;

    uint256 public roleHolders; // how many accounts hold roles, for the last-assignee rule
    bool public initialized;
    address public implementation;

    error NotAuthorized(address caller);
    error AlreadyInitialized();
    error LastRoleAssignee();

    function initialize(address admin, uint256 roleBitmap, bytes[] calldata setters) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        roles[admin] = roleBitmap;
        if (roleBitmap != 0) roleHolders++;
        for (uint256 i; i < setters.length; ++i) {
            (bool ok,) = address(this).call(setters[i]);
            require(ok, "setter failed");
        }
    }

    modifier authorized() {
        if (roles[msg.sender] == 0) revert NotAuthorized(msg.sender);
        _;
    }

    function setText(bytes32 node, string calldata key, string calldata value) external authorized {
        text[node][key] = value;
    }

    function setAddr(bytes32 node, address a) external authorized {
        addr[node] = a;
    }

    function grantRootRoles(uint256 roleBitmap, address account) external authorized returns (bool) {
        if (roles[account] == 0 && roleBitmap != 0) roleHolders++;
        roles[account] |= roleBitmap;
        return true;
    }

    function revokeRootRoles(uint256 roleBitmap, address account) external authorized returns (bool) {
        if (roles[account] != 0 && roleHolders == 1) revert LastRoleAssignee();
        uint256 next = roles[account] & ~roleBitmap;
        if (roles[account] != 0 && next == 0) roleHolders--;
        roles[account] = next;
        return true;
    }

    function hasRoles(address account) external view returns (bool) {
        return roles[account] != 0;
    }
}

/// @dev Mirrors `VerifiableFactory`: CREATE2 with `outerSalt = keccak256(msg.sender, salt)`.
contract MockVerifiableFactory {
    mapping(address proxy => address impl) internal _impl;

    function deployProxy(address implementation, uint256 salt, bytes calldata data)
        external
        returns (address proxy)
    {
        bytes32 outerSalt = keccak256(abi.encode(msg.sender, salt));
        proxy = address(new MockPermissionedResolver{salt: outerSalt}());
        _impl[proxy] = implementation;
        if (data.length > 0) {
            (bool ok,) = proxy.call(data);
            require(ok, "initialize failed");
        }
    }

    /// @dev Returns the implementation, which the caller compares to PermissionedResolverImpl
    ///      off-chain. That comparison is the trustless handle proof (§6.5 use #4).
    function verifyContract(address proxy) external view returns (address) {
        return _impl[proxy];
    }
}

/// @dev Mirrors the `UserRegistry` proxy slotted under `lortnoctahc.eth`.
contract MockLortnocRegistry {
    struct Entry {
        address owner;
        address registry;
        address resolver;
        uint256 roleBitmap;
        uint64 expiry;
    }

    mapping(string label => Entry) internal entries;
    mapping(address caller => bool) public isRegistrar;
    uint256 public nextTokenId = 1;

    error NotRegistrar();
    error AlreadyRegistered();

    function setRegistrar(address who, bool allowed) external {
        isRegistrar[who] = allowed;
    }

    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId) {
        // The whole reason claiming goes through the registrar: users do not hold ROLE_REGISTRAR.
        if (!isRegistrar[msg.sender]) revert NotRegistrar();
        if (entries[label].owner != address(0)) revert AlreadyRegistered();
        entries[label] = Entry(owner, registry, resolver, roleBitmap, expiry);
        tokenId = nextTokenId++;
    }

    function findOwner(string calldata label) external view returns (address) {
        return entries[label].owner;
    }

    function getResolver(string calldata label) external view returns (address) {
        return entries[label].resolver;
    }

    function entryOf(string calldata label) external view returns (Entry memory) {
        return entries[label];
    }
}

/// @dev Optional paid-tier nullifier gate (§7).
contract MockNullifierGate {
    mapping(bytes32 nullifier => bool) public spent;
    mapping(bytes32 nullifier => address) public spentBy;
    bool public shouldRevert;

    error NullifierSpent(bytes32 nullifier);
    error GateRejected();

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function spend(bytes32 nullifier, address claimant) external {
        if (shouldRevert) revert GateRejected();
        if (spent[nullifier]) revert NullifierSpent(nullifier);
        spent[nullifier] = true;
        spentBy[nullifier] = claimant;
    }
}
