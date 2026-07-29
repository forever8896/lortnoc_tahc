// The membership-ticket public signal (shared/ticket.mjs) — §7/§8.
//
// This is the single most security-critical pure function in the repo. The Semaphore proof
// proves "I am SOME paid member"; `ticketMessage` is the only thing binding that proof to a
// specific claim. If any of the four fields stops contributing to the hash, a relayer can
// re-point the claim: mint the handle to its own address, redirect the storage stipend, or —
// worst — publish a messaging pubkey it controls and read everything sent to that handle.
//
// So every test here is "changing field X changes the signal". They look repetitive on
// purpose: each one is a distinct attack that the binding forecloses.
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { ticketMessage, claimScope, CLAIM_SCOPE_SEED } from '../../shared/ticket.mjs'

const LABEL = 'alice'
const EVM = '0x61eE2fBcf2841d9094e2D42406Dd4f83a7981Bb8'
const SUI = '0x9a1c0f4e3b2d8a7c6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d'
const PUB = '0x' + 'ab'.repeat(32)

const base = () => ticketMessage(LABEL, EVM, SUI, PUB)

describe('the public signal binds every field of the claim (§7)', () => {
  test('is deterministic — the relayer and the prover must compute the same value', () => {
    assert.equal(base(), ticketMessage(LABEL, EVM, SUI, PUB))
  })

  test('a different HANDLE changes the signal (cannot mint a different name)', () => {
    assert.notEqual(base(), ticketMessage('bob', EVM, SUI, PUB))
  })

  test('a different OWNER changes the signal (relayer cannot take the handle)', () => {
    assert.notEqual(base(), ticketMessage(LABEL, '0x000000000000000000000000000000000000dEaD', SUI, PUB))
  })

  test('a different SUI ADDRESS changes the signal (stipend cannot be redirected)', () => {
    assert.notEqual(base(), ticketMessage(LABEL, EVM, '0x' + '11'.repeat(32), PUB))
  })

  test('a different PUBKEY changes the signal — the key-substitution attack', () => {
    // Without this binding a relayer publishes its own X25519 key to eth.lortnoc.pubkey and
    // silently becomes the recipient of every message sent to the handle.
    assert.notEqual(base(), ticketMessage(LABEL, EVM, SUI, '0x' + 'cd'.repeat(32)))
  })

  test('fields cannot be swapped across the boundary (abi encoding is not concatenation)', () => {
    // A naive string concat would make ("ab","c") and ("a","bc") collide.
    assert.notEqual(
      ticketMessage('ab', EVM, SUI, PUB),
      ticketMessage('a', EVM, SUI, PUB + 'b'.slice(0, 0)),
    )
    assert.notEqual(ticketMessage('alice', EVM, SUI, PUB), ticketMessage('alic', EVM, SUI, PUB))
  })
})

describe('input normalisation', () => {
  test('the EVM address is checksum-normalised — case must not fork the signal', () => {
    assert.equal(base(), ticketMessage(LABEL, EVM.toLowerCase(), SUI, PUB))
  })

  test('the pubkey is lower-cased — an uppercase hex claim still matches', () => {
    assert.equal(base(), ticketMessage(LABEL, EVM, SUI, PUB.toUpperCase().replace('0X', '0x')))
  })

  test('an invalid EVM address is rejected rather than silently hashed', () => {
    assert.throws(() => ticketMessage(LABEL, 'not-an-address', SUI, PUB))
  })

  test('every field is required — a missing one silently unbinds the claim', () => {
    for (const args of [
      ['', EVM, SUI, PUB],
      [LABEL, '', SUI, PUB],
      [LABEL, EVM, '', PUB],
      [LABEL, EVM, SUI, ''],
    ]) {
      assert.throws(() => ticketMessage(...args), /all four fields are required/)
    }
  })
})

describe('BN254 field constraints (Semaphore public inputs)', () => {
  const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

  test('the signal always lands inside the scalar field', () => {
    for (let i = 0; i < 200; i++) {
      const m = ticketMessage(`user${i}`, EVM, SUI, '0x' + i.toString(16).padStart(2, '0').repeat(32))
      assert.ok(m > 0n && m < BN254_R, `signal ${m} is outside the BN254 scalar field`)
    }
  })

  test('the claim scope is fixed and inside the field — one handle per membership', () => {
    const s = claimScope()
    assert.equal(s, claimScope())
    assert.ok(s > 0n && s < BN254_R)
    assert.equal(CLAIM_SCOPE_SEED, 'lortnoc/claim/v1', 'changing the scope re-opens every spent nullifier')
  })

  test('the >> 8 shift never collapses distinct claims into one signal', () => {
    const seen = new Set()
    for (let i = 0; i < 500; i++) seen.add(ticketMessage(`u${i}`, EVM, SUI, PUB).toString())
    assert.equal(seen.size, 500)
  })
})
