// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Grant} from "../../src/LortnocRegistrar.sol";

/// @notice Stand-ins for the pinned ENS v2 Sepolia deployment (`sepolia-deployment-2026-09-15`),
///         faithful to the parts LortnocRegistrar depends on and no further. The fork test
///         (`LortnocRegistrar.fork.t.sol`) runs the REAL bytecode; these mocks keep the unit tier
///         offline.
///
/// @dev Reproduced 09-15 behaviour:
///        * `initialize(Grant[] grants, bytes[] calls)` — `calls` run WITHOUT permission checks
///          while initializing (PermissionedResolver.sol:119-126,370-378). That is why the
///          registrar never needs, and never holds, a role on a handle's resolver.
///        * Setters take the DNS-encoded NAME (`setText(bytes,…)`, `setAddress(bytes,uint256,bytes)`).
///        * After init, writes are role-checked, so "the registrar cannot write" is a real assertion.

/// @dev Mirrors `PermissionedResolverImpl` @09-15 closely enough to test the handover.
contract MockPermissionedResolver {
    mapping(address account => uint256 roles) public roles;
    mapping(bytes32 nameHash => mapping(string key => string value)) internal _text;
    mapping(bytes32 nameHash => bytes) internal _addr;

    bool public initialized;
    bool internal _initializing;

    error NotAuthorized(address caller);
    error AlreadyInitialized();

    function initialize(Grant[] calldata grants, bytes[] calldata calls) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        _initializing = true;
        for (uint256 i; i < grants.length; ++i) roles[grants[i].account] |= grants[i].roleBitmap;
        for (uint256 i; i < calls.length; ++i) {
            (bool ok,) = address(this).call(calls[i]);
            require(ok, "init call failed");
        }
        _initializing = false;
    }

    modifier authorized() {
        if (!_initializing && roles[msg.sender] == 0) revert NotAuthorized(msg.sender);
        _;
    }

    function setText(bytes calldata name, string calldata key, string calldata value) external authorized {
        _text[keccak256(name)][key] = value;
    }

    function setAddress(bytes calldata name, uint256 coinType, bytes calldata a) external authorized {
        require(coinType == 60, "mock: ETH only");
        _addr[keccak256(name)] = a;
    }

    /// @dev Test-only reads. The real 09-15 resolver has NO direct getters — reads go through
    ///      `resolve(name, data)` via the UniversalResolver.
    function textOf(bytes calldata name, string calldata key) external view returns (string memory) {
        return _text[keccak256(name)][key];
    }

    function addrOf(bytes calldata name) external view returns (address) {
        bytes memory a = _addr[keccak256(name)];
        if (a.length != 20) return address(0);
        return address(bytes20(a));
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

    /// @dev Simulates expiry: the real registry reports owner 0 for an expired label.
    function release(string calldata label) external {
        delete entries[label];
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
