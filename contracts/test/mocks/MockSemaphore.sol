// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @notice Minimal ISemaphore stand-in for unit tests.
///
/// @dev Groth16 verification needs the bn254 precompiles and a Poseidon-linked deployment; that
///      belongs in a fork test against the real Galileo/mainnet deployment, not here. What these
///      unit tests are for is LortnocMembership's OWN logic — payment, double-join, treasury
///      forwarding, nullifier bookkeeping, admin guards — so the proof system is mocked and the
///      question "does a valid proof verify?" is left to Semaphore, which tests it upstream.
///
///      `validateProofShouldRevert` exists so tests can assert what happens when a proof does
///      NOT verify, which is the branch that actually matters here: the nullifier must already
///      have been written, and the whole transaction must roll back.
contract MockSemaphore is ISemaphore {
    uint256 public nextGroupId;
    mapping(uint256 groupId => address admin) public groupAdmin;
    mapping(uint256 groupId => uint256[] members) internal _members;

    bool public validateProofShouldRevert;
    uint256 public validateProofCalls;
    uint256 public lastValidatedGroup;

    error ProofRejected();

    function setValidateProofShouldRevert(bool v) external {
        validateProofShouldRevert = v;
    }

    function membersOf(uint256 groupId) external view returns (uint256[] memory) {
        return _members[groupId];
    }

    function memberCountOf(uint256 groupId) external view returns (uint256) {
        return _members[groupId].length;
    }

    // ---- ISemaphore surface actually used by LortnocMembership -------------------------------

    function createGroup() external returns (uint256) {
        return _createGroup(msg.sender);
    }

    function createGroup(address admin) external returns (uint256) {
        return _createGroup(admin);
    }

    function createGroup(address admin, uint256) external returns (uint256) {
        return _createGroup(admin);
    }

    function _createGroup(address admin) internal returns (uint256 id) {
        id = nextGroupId++;
        groupAdmin[id] = admin;
    }

    function addMember(uint256 groupId, uint256 identityCommitment) external {
        require(msg.sender == groupAdmin[groupId], "not group admin");
        _members[groupId].push(identityCommitment);
    }

    function validateProof(uint256 groupId, SemaphoreProof calldata) external {
        validateProofCalls++;
        lastValidatedGroup = groupId;
        if (validateProofShouldRevert) revert ProofRejected();
    }

    // ---- unused ISemaphore surface -----------------------------------------------------------

    function updateGroupMerkleTreeDuration(uint256, uint256) external {}
    function updateGroupAdmin(uint256, address) external {}
    function acceptGroupAdmin(uint256) external {}
    function addMembers(uint256 groupId, uint256[] calldata commitments) external {
        require(msg.sender == groupAdmin[groupId], "not group admin");
        for (uint256 i; i < commitments.length; ++i) _members[groupId].push(commitments[i]);
    }
    function updateMember(uint256, uint256, uint256, uint256[] calldata) external {}
    function removeMember(uint256, uint256, uint256[] calldata) external {}
    function verifyProof(uint256, SemaphoreProof calldata) external view returns (bool) {
        return !validateProofShouldRevert;
    }
    function groupCounter() external view returns (uint256) {
        return nextGroupId;
    }
}
