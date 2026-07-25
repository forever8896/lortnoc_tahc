// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Pulled in only so `forge build` produces deployable artifacts for the canonical Semaphore
// contracts. We deploy them verbatim on 0G Galileo (nothing is deployed there yet) and never
// modify them — the verifier is the audited Groth16 circuit verifier, and Semaphore itself
// manages the LeanIMT member tree and rejects reused nullifiers.
import {Semaphore} from "@semaphore-protocol/contracts/Semaphore.sol";
import {SemaphoreVerifier} from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
// LeanIMT hashes with Poseidon, which solc emits as an external library call — the Semaphore
// bytecode ships with an unlinked placeholder until PoseidonT3 is deployed and linked in.
import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
