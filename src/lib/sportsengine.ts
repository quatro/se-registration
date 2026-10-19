import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db.js'
import { ageFor, audit, changed, division, divisionForProgram, fitsAge, getPlayer, getSettings, publicState, type Division, type Player } from './league.js'
import { nameKey, normDate, parseCsv, uid } from './text.js'

// SportsEngine registration intake — the one webhook for every league tool.
//
// The payload schema isn't confirmed yet, so extract() is deliberately
// tolerant (same approach as the draft board): it walks the payload for the
// usual spellings of participant name, birthdate, ids, season and program.
// Every delivery is stored raw first, so once real payloads arrive the mapping
// can be tightened and the inbox replayed from /admin.
//
// Placement follows the program the family picked in SportsEngine. An admin
// can move a kid afterwards; that move is pinned and wins over the program.

export interface Extracted {
  eventId: string | null
  eventType: string | null
  firstName: string | null
  lastName: string | null
  birthdate: string | null
  regYear: number | null
  program: string | null
  seProfileId: string | null
  seRegistrationId: string | null
  cancelled: boolean
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')

const FIRST = ['firstname', 'first', 'givenname', 'participantfirstname', 'playerfirstname', 'athletefirstname']
const LAST = ['lastname', 'last', 'familyname', 'surname', 'participantlastname', 'playerlastname', 'athletelastname']
const FULL = ['fullname', 'name', 'participantname', 'playername', 'athletename']
const DOB = ['dateofbirth', 'dob', 'birthdate', 'birthday', 'birthdt', 'participantdob', 'playerdob']
const PROFILE = ['profileid', 'personid', 'participantid', 'athleteid', 'playerid', 'personaid', 'userid']
const REGID = ['registrationresultid', 'registrationid', 'resultid', 'submissionid', 'orderid']
const YEAR = ['season', 'seasonname', 'registrationyear', 'year', 'seasonyear']
// Most specific first: a "division" answer beats the registration form's title.
const PROGRAM = ['division', 'divisionname', 'program', 'programname', 'offering', 'offeringname', 'level', 'league', 'agegroup',
  'productname', 'itemname', 'registrationname', 'formname', 'surveyname', 'title']
const LABEL = ['registrationname', 'formname', 'programname', 'surveyname', 'title', 'name', 'season', 'seasonname']
const PERSON_KEYS = ['participant', 'player', 'athlete', 'registrant', 'profile', 'person', 'child', 'member']

function walk(o: unknown, fn: (k: string, v: unknown, path: string[]) => void, path: string[] = [], depth = 0) {
  if (depth > 8) return
  if (Array.isArray(o)) o.forEach((v, i) => walk(v, fn, [...path, String(i)], depth + 1))
  else if (isObj(o)) for (const [k, v] of Object.entries(o)) { fn(k, v, path); walk(v, fn, [...path, k], depth + 1) }
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number') return String(v)
  return null
}

/** First value under any of `keys`. Person fields prefer participant-like paths; others (program) prefer the rest. */
function find(payload: unknown, keys: string[], prefer: 'person' | 'other' = 'person'): string | null {
  let best: { v: string; score: number } | null = null
  walk(payload, (k, v, path) => {
    const s = scalar(v)
    if (!s) return
    const i = keys.indexOf(norm(k))
    if (i < 0) return
    const inPerson = path.some((p) => PERSON_KEYS.includes(norm(p)))
    const person = prefer === 'person' ? (inPerson ? 0 : 100) : (inPerson ? 100 : 0)
    const guardian = path.some((p) => /guardian|parent|contact|billing|purchaser|account/.test(norm(p))) ? 1000 : 0
    const score = guardian + person + i * 2 + path.length
    if (!best || score < best.score) best = { v: s, score }
  })
  return (best as { v: string } | null)?.v ?? null
}

export function extract(payload: unknown): Extracted {
  let firstName = find(payload, FIRST)
  let lastName = find(payload, LAST)
  if (!firstName || !lastName) {
    const full = find(payload, FULL)
    if (full && /\s/.test(full)) {
      const parts = full.split(/\s+/)
      firstName ??= parts.slice(0, -1).join(' ')
      lastName ??= parts.at(-1)!
    }
  }
  let regYear: number | null = null
  const y = find(payload, YEAR)
  if (y && /^(20\d\d)$/.test(y)) regYear = +y
  if (!regYear) {
    for (const k of [...YEAR, ...LABEL]) {
      const m = /\b(20\d\d)\b/.exec(find(payload, [k], 'other') ?? '')
      if (m) { regYear = +m[1]!; break }
    }
  }
  const eventType = find(payload, ['type', 'event', 'eventtype', 'topic', 'action'], 'other')
  return {
    eventId: isObj(payload) ? scalar(payload.id) ?? scalar(payload.event_id) ?? scalar(payload.eventId) ?? null : null,
    eventType,
    firstName, lastName,
    birthdate: normDate(find(payload, DOB)),
    regYear,
    program: find(payload, PROGRAM, 'other'),
    seProfileId: find(payload, PROFILE),
    seRegistrationId: find(payload, REGID),
    cancelled: /cancel|withdraw|refund|delete|void/i.test(eventType ?? ''),
  }
}

export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false
  const given = header.replace(/^sha256=/i, '').trim()
  const hex = createHmac('sha256', secret).update(raw).digest('hex')
  const b64 = Buffer.from(hex, 'hex').toString('base64')
  for (const want of [hex, b64]) {
    const a = Buffer.from(given), b = Buffer.from(want)
    if (a.length === b.length && timingSafeEqual(a, b)) return true
  }
  return false
}

// ---------- matching ----------
export type Outcome = 'placed' | 'returner' | 'no_division' | 'wrong_year' | 'ambiguous' | 'withdrawn' | 'ignored' | 'error'
type Result = { outcome: Outcome; note: string; playerId?: string; divisionId?: string }

export function matchPlayer(x: Pick<Extracted, 'firstName' | 'lastName' | 'birthdate' | 'seProfileId'>): { player?: Player; ambiguous?: string } {
  if (x.seProfileId) {
    const p = db.prepare('SELECT * FROM players WHERE se_profile_id = ?').get(x.seProfileId) as Player | undefined
    if (p) return { player: p }
  }
  if (!x.firstName || !x.lastName) return {}
  let cands = db.prepare('SELECT * FROM players WHERE name_key = ?').all(nameKey(`${x.firstName} ${x.lastName}`)) as Player[]
  if (x.birthdate) cands = cands.filter((c) => !c.birthdate || c.birthdate === x.birthdate)
  if (cands.length === 1) return { player: cands[0]! }
  if (cands.length > 1) return { ambiguous: `${cands.length} players named ${x.firstName} ${x.lastName}` }
  return {}
}

function overNote(d: Division): string {
  const v = (publicState(false).divisions.find((x) => x.id === d.id))?.seats
  return v && v.capacity && v.open < 0 ? ` — ${d.name} is now ${-v.open} over capacity` : ''
}
function ageNote(d: Division, birthdate: string | null): string {
  const age = ageFor(birthdate)
  return age != null && !fitsAge(d, age) ? ` — league age ${age} is outside ${d.name} (${d.min_age ?? '?'}–${d.max_age ?? '?'})` : ''
}

/** Put a registration on a player (existing or new) in `target`. */
function apply(regId: number, p: Player | undefined, x: Extracted, target: Division | undefined, actor: string, pin = false): Result {
  if (x.cancelled) {
    if (!p) return { outcome: 'ignored', note: 'cancellation for a player we don\'t have' }
    db.prepare('UPDATE registrations SET player_id = ? WHERE id = ?').run(p.id, regId)
    if (p.status_locked) return { outcome: 'withdrawn', note: `cancellation — status locked at "${p.status}", not changed`, playerId: p.id }
    db.prepare(`UPDATE players SET status = 'Withdrawn', updated_at = datetime('now') WHERE id = ?`).run(p.id)
    audit(actor, 'withdrawn_in_sportsengine', p.id, { registration: regId, from: p.status })
    return { outcome: 'withdrawn', note: `${p.status} → Withdrawn (seat released)`, playerId: p.id, divisionId: p.division_id ?? undefined }
  }
  if (!p) {
    if (!target) return { outcome: 'no_division', note: x.program ? `no division matches program "${x.program}"` : 'no program found in payload' }
    if (!x.firstName || !x.lastName) return { outcome: 'error', note: 'no participant name found in payload' }
    const id = uid(), name = `${x.firstName} ${x.lastName}`
    db.prepare(`INSERT INTO players (id, name, name_key, birthdate, returner, division_id, division_locked, status, se_program, se_profile_id,
      se_registration_id, registered_at) VALUES (?, ?, ?, ?, 0, ?, ?, 'Registered', ?, ?, ?, datetime('now'))`)
      .run(id, name, nameKey(name), x.birthdate, target.id, pin ? 1 : 0, x.program, x.seProfileId, x.seRegistrationId)
    audit(actor, 'registered_new', id, { registration: regId, division: target.name })
    db.prepare('UPDATE registrations SET player_id = ? WHERE id = ?').run(id, regId)
    return { outcome: 'placed', note: `new player in ${target.name}${ageNote(target, x.birthdate)}${overNote(target)}`, playerId: id, divisionId: target.id }
  }

  // Existing kid (usually an expected returner). An admin's pinned division wins over the program.
  let dest = target ?? (p.division_id ? division(p.division_id) : undefined)
  let note = ''
  if (p.division_locked && p.division_id && !pin) {
    dest = division(p.division_id)
    if (target && target.id !== p.division_id) note += ` — registered for ${target.name}, kept in ${dest?.name} (moved by an admin)`
  } else if (dest && p.division_id && dest.id !== p.division_id) note += ` — moved from ${division(p.division_id)?.name ?? '?'} to ${dest.name} per their program`
  const takenId = x.seProfileId && db.prepare('SELECT 1 FROM players WHERE se_profile_id = ? AND id <> ?').get(x.seProfileId, p.id) ? null : x.seProfileId
  db.prepare(`UPDATE players SET se_profile_id = COALESCE(se_profile_id, ?), se_registration_id = COALESCE(?, se_registration_id),
    birthdate = COALESCE(birthdate, ?), se_program = COALESCE(?, se_program), division_id = ?, division_locked = MAX(division_locked, ?),
    updated_at = datetime('now') WHERE id = ?`).run(takenId, x.seRegistrationId, x.birthdate, x.program, dest?.id ?? null, pin ? 1 : 0, p.id)
  db.prepare('UPDATE registrations SET player_id = ? WHERE id = ?').run(p.id, regId)
  if (!dest) note += ' — not in a division yet; place them from Players'
  if (p.status_locked) note = `status locked at "${p.status}" by an admin — not changed${note}`
  else if (p.status === 'Registered') note = `already Registered${note}`
  else {
    db.prepare(`UPDATE players SET status = 'Registered', registered_at = datetime('now') WHERE id = ?`).run(p.id)
    audit(actor, 'registered', p.id, { registration: regId, from: p.status, division: dest?.name ?? null })
    note = `${p.status} → Registered${note}`
  }
  if (dest) note += ageNote(dest, p.birthdate ?? x.birthdate) + overNote(dest)
  return { outcome: p.returner ? 'returner' : 'placed', note, playerId: p.id, divisionId: dest?.id }
}

interface RegRow { id: number; raw: string; source: string; signature: string | null; batched: number; forwarded: string | null }

export function processRegistration(regId: number, actor = 'sportsengine'): Result {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId) as RegRow | undefined
  if (!r) throw new Error('no such registration')
  let x: Extracted
  try { x = extract(JSON.parse(r.raw)) } catch (e) {
    db.prepare(`UPDATE registrations SET outcome = 'error', note = ? WHERE id = ?`).run(String(e), regId)
    return { outcome: 'error', note: String(e) }
  }
  db.prepare(`UPDATE registrations SET event_type=?, first_name=?, last_name=?, birthdate=?, reg_year=?, program=?, se_profile_id=?, se_registration_id=? WHERE id=?`)
    .run(x.eventType, x.firstName, x.lastName, x.birthdate, x.regYear, x.program, x.seProfileId, x.seRegistrationId, regId)
  const s = getSettings()
  let res: Result
  if (x.regYear && x.regYear !== s.registrationYear) res = { outcome: 'wrong_year', note: `registration is for ${x.regYear}, tracking ${s.registrationYear}` }
  else {
    const m = matchPlayer(x)
    if (m.ambiguous) res = { outcome: 'ambiguous', note: m.ambiguous }
    else res = db.transaction(() => apply(regId, m.player, x, divisionForProgram(x.program), actor))()
    if (!x.regYear) res.note += ' (season not found in payload)'
  }
  finish(r, res)
  return res
}

function finish(r: RegRow, res: Result) {
  db.prepare('UPDATE registrations SET outcome = ?, note = ?, division_id = ? WHERE id = ?').run(res.outcome, res.note, res.divisionId ?? null, r.id)
  changed()
  const d = res.divisionId ? division(res.divisionId) : undefined
  if (d?.forward && r.source === 'webhook' && r.forwarded !== 'ok') void relay(r.id)
}

// ---------- relay to the draft board ----------
/**
 * Re-send a registration to the draft board's webhook. A single-event delivery
 * goes out byte-for-byte with SportsEngine's signature header, so the board's
 * own check still passes once both apps share the signing secret.
 */
export async function relay(regId: number): Promise<string> {
  const url = config.draftBoardWebhookUrl
  if (!url) return 'not configured'
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId) as RegRow | undefined
  if (!r) return 'no such registration'
  let result: string
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Relayed-By': 'se-registration' }
    if (r.signature && !r.batched) headers[config.sportsengine.signatureHeader] = r.signature
    const resp = await fetch(url, { method: 'POST', headers, body: r.raw, signal: AbortSignal.timeout(10_000) })
    result = resp.ok ? 'ok' : `failed: HTTP ${resp.status}`
  } catch (e) {
    result = `failed: ${(e as Error).message}`
  }
  db.prepare('UPDATE registrations SET forwarded = ? WHERE id = ?').run(result, regId)
  if (result !== 'ok') console.error('[relay] draft board', regId, result)
  changed()
  return result
}

export function storeRegistration(source: 'webhook' | 'csv' | 'manual', raw: string, payload: unknown, verified: boolean,
  signature: string | null = null, batched = false): { id: number; duplicate: boolean } {
  const x = extract(payload)
  if (x.eventId) {
    const dup = db.prepare('SELECT id FROM registrations WHERE event_id = ?').get(`${source}:${x.eventId}`) as { id: number } | undefined
    if (dup) return { id: dup.id, duplicate: true }
  }
  const id = Number(db.prepare('INSERT INTO registrations (source, event_id, verified, raw, signature, batched) VALUES (?, ?, ?, ?, ?, ?)')
    .run(source, x.eventId ? `${source}:${x.eventId}` : null, verified ? 1 : 0, raw, signature, batched ? 1 : 0).lastInsertRowid)
  return { id, duplicate: false }
}

/**
 * Admin resolves an inbox item: attach it to an existing player and/or put it
 * in a chosen division. A division chosen here is pinned like any admin move.
 */
export function placeRegistration(regId: number, opts: { playerId?: string | null; divisionId?: string | null }, actor: string): Result {
  const r = db.prepare('SELECT * FROM registrations WHERE id = ?').get(regId) as RegRow | undefined
  if (!r) throw new Error('no such registration')
  const x = extract(JSON.parse(r.raw))
  const p = opts.playerId ? getPlayer(opts.playerId) : undefined
  if (opts.playerId && !p) throw new Error('unknown player')
  const target = opts.divisionId ? division(opts.divisionId) : divisionForProgram(x.program)
  if (opts.divisionId && !target) throw new Error('unknown division')
  if (!p && !target) throw new Error('pick a division for this player')
  const res = db.transaction(() => apply(regId, p, { ...x, cancelled: false }, target, actor, !!opts.divisionId))()
  res.note += ` (placed by ${actor})`
  audit(actor, 'registration_placed', res.playerId ?? null, { registration: regId, division: target?.name ?? null })
  finish(r, res)
  return res
}

export function ignoreRegistration(regId: number, actor: string) {
  db.prepare(`UPDATE registrations SET outcome = 'ignored', note = ? WHERE id = ?`).run(`ignored by ${actor}`, regId)
  changed()
}

/** SportsEngine registration report export (CSV). Each row runs through the same placement as a webhook. */
export function importRegistrationCsv(text: string, actor: string) {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new Error('Expected a header row and at least one registration')
  const header = rows[0]!.map((h) => h.trim())
  const tally: Record<string, number> = {}
  for (const row of rows.slice(1)) {
    const obj: Obj = { participant: Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])) }
    const { id } = storeRegistration('csv', JSON.stringify(obj), obj, true)
    const res = processRegistration(id, actor)
    tally[res.outcome] = (tally[res.outcome] ?? 0) + 1
  }
  audit(actor, 'registrations_imported', null, tally)
  return tally
}
