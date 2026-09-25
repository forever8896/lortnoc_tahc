// The messenger's time formatting. Pure functions, so they are cheap to pin — and worth pinning,
// because every one of them is read at a glance and a wrong answer is not obviously wrong.
//
// Imports the real UI helpers, never a copy (test/README.md, the one rule for this suite).
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { relativeTime, clockTime, dayLabel, opensNewDay } from '../../app/src/ui/time.ts'

// A fixed "now" so these never go red at midnight or in another timezone's afternoon.
const NOW = new Date('2026-08-28T15:00:00').getTime()
const ago = (ms) => NOW - ms
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

describe('relativeTime — the sidebar glance', () => {
  test('sub-minute reads as "now", not "0m"', () => {
    assert.equal(relativeTime(ago(5_000), NOW), 'now')
    assert.equal(relativeTime(ago(59_000), NOW), 'now')
  })

  test('minutes and hours are floored, so a thing is never aged up', () => {
    assert.equal(relativeTime(ago(4 * MIN + 59_000), NOW), '4m')
    assert.equal(relativeTime(ago(3 * HOUR + 59 * MIN), NOW), '3h')
  })

  test('the boundaries land on the larger unit', () => {
    assert.equal(relativeTime(ago(MIN), NOW), '1m')
    assert.equal(relativeTime(ago(HOUR), NOW), '1h')
  })

  test('inside a week it is a weekday name, beyond it a date', () => {
    // 2026-08-26 was a Wednesday; two days before the fixed now.
    assert.equal(relativeTime(ago(2 * DAY), NOW), new Date(ago(2 * DAY)).toLocaleDateString(undefined, { weekday: 'short' }))
    const old = relativeTime(ago(30 * DAY), NOW)
    assert.match(old, /\d/, 'a month-old row should carry a date, not a weekday')
  })

  test('a conversation with no messages (ts 0) renders nothing at all', () => {
    // Conversations sort by updatedAt, and an empty one is 0. Printing "56 years" there would be
    // the single most confusing thing in the list.
    assert.equal(relativeTime(0, NOW), '')
  })
})

describe('dayLabel / opensNewDay — thread separators', () => {
  test('today and yesterday are named, not dated', () => {
    assert.equal(dayLabel(ago(HOUR), NOW), 'Today')
    assert.equal(dayLabel(ago(DAY), NOW), 'Yesterday')
  })

  test('"yesterday" is a calendar day, not 24 hours', () => {
    // 23:30 last night vs 00:30 today are 1h apart but different days — the separator has to
    // follow the calendar or a late-night thread shows no break at all.
    const lateLastNight = new Date('2026-08-27T23:30:00').getTime()
    const earlyToday = new Date('2026-08-28T00:30:00').getTime()
    assert.equal(dayLabel(lateLastNight, NOW), 'Yesterday')
    assert.equal(dayLabel(earlyToday, NOW), 'Today')
    assert.equal(opensNewDay(earlyToday, lateLastNight), true, 'an hour apart across midnight is a new day')
  })

  test('the first message always opens a day', () => {
    assert.equal(opensNewDay(NOW, undefined), true)
  })

  test('two messages in the same day do not repeat the separator', () => {
    assert.equal(opensNewDay(ago(HOUR), ago(2 * HOUR)), false)
  })
})

describe('clockTime', () => {
  test('is hour:minute, with no seconds and no date', () => {
    const out = clockTime(new Date('2026-08-28T14:32:07').getTime())
    assert.match(out, /\d{1,2}[:.]\d{2}/)
    assert.ok(!/07/.test(out.replace(/^\d{1,2}/, '')), `seconds leaked into "${out}"`)
  })
})
