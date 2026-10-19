import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

process.env.DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), 'sereg-')), 't.db')
process.env.DRAFT_BOARD_WEBHOOK_URL = ''
const { seats } = await import('../src/lib/capacity.js')
const L = await import('../src/lib/league.js')
const SE = await import('../src/lib/sportsengine.js')
const { db } = await import('../src/db.js')

const reg = (first: string, last: string, program: string, extra: Record<string, unknown> = {}) => {
  const payload = { id: `e-${first}-${last}-${Math.random()}`, type: 'registration.completed', season: '2027', program_name: program,
    participant: { first_name: first, last_name: last, ...extra } }
  const { id } = SE.storeRegistration('webhook', JSON.stringify(payload), payload, false)
  return { id, ...SE.processRegistration(id) }
}
const byName = (n: string) => db.prepare('SELECT * FROM players WHERE name = ?').get(n) as L.Player
const seatsOf = (id: string) => L.publicState(false).divisions.find((d) => d.id === id)!.seats

test('seat math: capacity, held returners, open and state', () => {
  const d = { teams: 2, roster_size: 3, coaches: 1, closed: 0 }
  const s = seats(d, [
    { status: 'Registered', returner: 1 }, { status: 'Registered', returner: 0 },
    { status: 'Expected', returner: 1 }, { status: 'Need to contact', returner: 1 },
    { status: 'Not returning', returning: 1 }, { status: 'Waitlist', returning: 0 },
  ], 2)
  assert.equal(s.capacity, 6)
  assert.equal(s.registered, 2)
  assert.equal(s.held, 2)
  assert.equal(s.open, 2)
  assert.equal(s.bestCaseOpen, 3)
  assert.equal(s.state, 'closing')
  assert.equal(s.coachGap, 1)
  assert.equal(s.teamsNeeded, 2)
  assert.equal(seats({ ...d, teams: 1 }, [{ status: 'Registered', returner: 0 }, { status: 'Registered', returner: 0 }, { status: 'Expected', returner: 1 }, { status: 'Expected', returner: 1 }], 2).state, 'over')
  assert.equal(seats({ ...d, teams: 0 }, [], 2).state, 'unset')
})

test('setup: divisions with age ranges and SE program words', () => {
  L.saveDivision(null, { name: 'Minors', teams: 1, roster_size: 3, min_age: 8, max_age: 10, se_match: 'minors, minor league' }, 't')
  L.saveDivision(null, { name: 'Majors', teams: 1, roster_size: 3, min_age: 10, max_age: 12, se_match: 'majors', forward: true }, 't')
  assert.equal(L.divisionForProgram('2027 Spring Baseball - Minor League (8-10)')?.id, 'minors')
  assert.equal(L.divisionForProgram('MAJORS 2027')?.id, 'majors')
  assert.equal(L.divisionForProgram('T-Ball'), undefined)
})

test('returners: aged up by league age, kept in place when still eligible, aged out skipped', () => {
  // Season 2027, cutoff 04-30.
  const r = L.importReturners([
    'Name,Birthdate,Division,Team',
    'Ava Stay,2017-06-01,Minors,Cubs',        // 9 → stays Minors
    'Ben Up,2016-03-01,Minors,Cubs',          // 11 → too old for Minors → Majors
    'Cal Ten,2016-12-01,Minors,Cubs',         // 10 → fits both; stays Minors
    'Dee Old,2013-01-01,Majors,Reds',         // 14 → aged out
    'Eli Nodob,,Majors,Reds',                 // no birthdate → same division
    'Ava Stay,2017-06-01,Minors,Cubs',        // duplicate
  ].join('\n'), 't')
  assert.deepEqual({ added: r.added, dup: r.duplicates, out: r.agedOut }, { added: 4, dup: 1, out: 1 })
  assert.equal(byName('Ava Stay').division_id, 'minors')
  assert.equal(byName('Ben Up').division_id, 'majors')
  assert.equal(byName('Cal Ten').division_id, 'minors')
  assert.equal(byName('Eli Nodob').division_id, 'majors')
  assert.equal(byName('Ben Up').status, 'Expected')
  assert.equal(byName('Ben Up').prior_division, 'Minors · Cubs')
  assert.equal(seatsOf('majors').held, 2)
})

test('registration: returner is matched and flips to Registered', () => {
  const r = reg('Ben', 'Up', 'Majors')
  assert.equal(r.outcome, 'returner')
  assert.equal(byName('Ben Up').status, 'Registered')
  assert.equal(seatsOf('majors').held, 1)
  assert.equal(seatsOf('majors').registered, 1)
})

test('registration: new kid placed by program; over-capacity is noted', () => {
  const a = reg('Fay', 'New', 'Majors', { date_of_birth: '2015-09-01' })
  assert.equal(a.outcome, 'placed')
  assert.equal(byName('Fay New').division_id, 'majors')
  assert.equal(seatsOf('majors').open, 0)
  assert.equal(seatsOf('majors').state, 'full')
  const b = reg('Gus', 'Late', 'Majors')
  assert.match(b.note, /1 over capacity/)
  assert.equal(seatsOf('majors').state, 'over')
})

test('admin move to another division is pinned and survives a re-run', () => {
  const r = reg('Hal', 'Wrong', 'Majors', { date_of_birth: '2018-02-01' })  // age 9, picked Majors by mistake
  assert.match(r.note, /outside Majors/)
  const p = byName('Hal Wrong')
  L.movePlayer(p.id, 'minors', 'admin', 'family picked the wrong program')
  assert.equal(byName('Hal Wrong').division_id, 'minors')
  assert.equal(byName('Hal Wrong').division_locked, 1)
  const again = SE.processRegistration(r.id)
  assert.equal(byName('Hal Wrong').division_id, 'minors')
  assert.match(again.note, /kept in Minors \(moved by an admin\)/)
  const log = db.prepare(`SELECT detail FROM audit WHERE action = 'division_moved' AND player_id = ?`).get(p.id) as { detail: string }
  assert.deepEqual(JSON.parse(log.detail), { from: 'Majors', to: 'Minors', reason: 'family picked the wrong program' })
})

test('unknown program lands in the inbox; admin places it in a pinned division', () => {
  const r = reg('Ivy', 'Lost', 'Fall Ball Clinic')
  assert.equal(r.outcome, 'no_division')
  assert.equal(byName('Ivy Lost'), undefined)
  const placed = SE.placeRegistration(r.id, { divisionId: 'minors' }, 'admin')
  assert.equal(placed.outcome, 'placed')
  assert.equal(byName('Ivy Lost').division_id, 'minors')
  assert.equal(byName('Ivy Lost').division_locked, 1)
})

test('cancellation withdraws the kid and releases the seat', () => {
  const before = seatsOf('majors').registered
  const payload = { id: 'cancel-1', type: 'registration.cancelled', season: '2027', program_name: 'Majors', participant: { first_name: 'Gus', last_name: 'Late' } }
  const { id } = SE.storeRegistration('webhook', JSON.stringify(payload), payload, false)
  assert.equal(SE.processRegistration(id).outcome, 'withdrawn')
  assert.equal(byName('Gus Late').status, 'Withdrawn')
  assert.equal(seatsOf('majors').registered, before - 1)
})

test('wrong season is filed and changes nothing', () => {
  const payload = { id: 'old-1', season: '2026', program_name: 'Minors', participant: { first_name: 'Ava', last_name: 'Stay' } }
  const { id } = SE.storeRegistration('webhook', JSON.stringify(payload), payload, false)
  assert.equal(SE.processRegistration(id).outcome, 'wrong_year')
  assert.equal(byName('Ava Stay').status, 'Expected')
})

test('extract prefers the program over the participant name, and CSV rows work', () => {
  const x = SE.extract({ data: { participant: { name: 'Jo Ray', first_name: 'Jo', last_name: 'Ray' }, registration: { name: 'Spring 2027', division: { name: 'Minors' } }, program: { name: 'x' }, division_name: 'Minors' } })
  assert.equal(x.program, 'Minors')
  assert.equal(x.regYear, 2027)
  const t = SE.importRegistrationCsv('First Name,Last Name,Date of Birth,Program Name\nKit,Csv,1/2/2018,Minor League', 'admin')
  assert.equal(t.placed, 1)
  assert.equal(byName('Kit Csv').division_id, 'minors')
})
