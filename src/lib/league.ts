import { EventEmitter } from 'node:events'
import { config } from '../config.js'
import { db } from '../db.js'
import { seats, type Seats } from './capacity.js'
import { leagueAge, nameKey, normDate, parseCsv, slug, STATUSES, uid, type Status } from './text.js'

// ---------- change feed ----------
// Every mutation bumps the version; connected pages refetch on the event.
export const bus = new EventEmitter()
bus.setMaxListeners(0)
let version = Date.now()
export function changed() {
  version++
  bus.emit('change', version)
}
export const currentVersion = () => version

export class UserError extends Error {}

// ---------- rows ----------
export interface Division {
  id: string; name: string; sort: number; teams: number; roster_size: number; coaches: number | null
  min_age: number | null; max_age: number | null; se_match: string; forward: number; closed: number; notes: string
}
export interface Player {
  id: string; name: string; name_key: string; birthdate: string | null; returner: number; prior_division: string
  division_id: string | null; division_locked: number; status: Status; status_locked: number; notes: string
  se_program: string | null; se_profile_id: string | null; se_registration_id: string | null
  registered_at: string | null; created_at: string; updated_at: string
}
export interface Settings { season: string; registrationYear: number; ageCutoff: string; warnAt: number }

export function getSettings(): Settings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) as Settings
}
export function setSettings(p: Partial<Settings>) {
  const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  for (const [k, v] of Object.entries(p)) if (v !== undefined) up.run(k, JSON.stringify(v))
}

export function audit(actor: string, action: string, playerId: string | null, detail: unknown = '') {
  db.prepare('INSERT INTO audit (actor, action, player_id, detail) VALUES (?, ?, ?, ?)')
    .run(actor, action, playerId, typeof detail === 'string' ? detail : JSON.stringify(detail))
}

export const divisions = () => db.prepare('SELECT * FROM divisions ORDER BY sort, name').all() as Division[]
export const division = (id: string) => db.prepare('SELECT * FROM divisions WHERE id = ?').get(id) as Division | undefined
export const getPlayer = (id: string) => db.prepare('SELECT * FROM players WHERE id = ?').get(id) as Player | undefined
const allPlayers = () => db.prepare('SELECT * FROM players ORDER BY name').all() as Player[]

export function ageFor(birthdate: string | null, s = getSettings()): number | null {
  return birthdate ? leagueAge(birthdate, Number(s.season) || s.registrationYear, s.ageCutoff) : null
}
export function fitsAge(d: Division, age: number | null): boolean {
  if (age == null) return true
  return (d.min_age == null || age >= d.min_age) && (d.max_age == null || age <= d.max_age)
}

// ---------- placement ----------
/** Division for an SE program name: the first division (by sort) any of whose match words appear in it. */
export function divisionForProgram(program: string | null, list = divisions()): Division | undefined {
  if (!program) return undefined
  const hay = ` ${nameKey(program)} `
  for (const d of list) {
    const words = (d.se_match || d.name).split(',').map((w) => nameKey(w)).filter(Boolean)
    if (words.some((w) => hay.includes(` ${w} `))) return d
  }
  return undefined
}

/** Next season's division for a returner by league age, preferring to stay put, then the next level up. */
export function divisionForAge(age: number | null, prior: Division | undefined, list = divisions()): Division | undefined {
  if (age == null) return undefined
  const fits = list.filter((d) => (d.min_age != null || d.max_age != null) && fitsAge(d, age))
  if (!fits.length) return undefined
  if (prior && fits.some((d) => d.id === prior.id)) return prior
  if (prior) return fits.find((d) => d.sort > prior.sort) ?? fits[0]
  return fits[0]
}

function divisionByName(name: string, list = divisions()): Division | undefined {
  const k = nameKey(name)
  if (!k) return undefined
  return list.find((d) => nameKey(d.name) === k) ?? divisionForProgram(name, list)
}

// ---------- state ----------
export interface DivisionView extends Division { seats: Seats; ageMismatches?: number }

export function publicState(isAdmin: boolean) {
  const s = getSettings()
  const ps = allPlayers()
  const divs: DivisionView[] = divisions().map((d) => {
    const mine = ps.filter((p) => p.division_id === d.id)
    const v: DivisionView = { ...d, seats: seats(d, mine, s.warnAt) }
    if (isAdmin) v.ageMismatches = mine.filter((p) => p.status !== 'Withdrawn' && !fitsAge(d, ageFor(p.birthdate, s))).length
    else { v.se_match = ''; v.notes = '' }
    return v
  })
  const total = divs.reduce((a, d) => ({
    capacity: a.capacity + d.seats.capacity, registered: a.registered + d.seats.registered,
    held: a.held + d.seats.held, open: a.open + Math.max(0, d.seats.open), waitlist: a.waitlist + d.seats.waitlist,
  }), { capacity: 0, registered: 0, held: 0, open: 0, waitlist: 0 })
  const base = {
    version: currentVersion(), canWrite: isAdmin, settings: s, divisions: divs, total,
    unplaced: ps.filter((p) => !p.division_id && p.status !== 'Withdrawn' && p.status !== 'Not returning').length,
    links: { draftBoard: config.draftBoardUrl || null },
  }
  if (!isAdmin) return base
  const openRegs = (db.prepare(`SELECT COUNT(*) AS n FROM registrations WHERE outcome IN ('no_division','ambiguous','error','pending')`).get() as { n: number }).n
  return {
    ...base,
    openRegistrations: openRegs,
    players: ps.map((p) => ({ ...p, age: ageFor(p.birthdate, s) })),
    webhookUrl: config.sportsengine.token ? `${config.baseUrl}/webhooks/sportsengine/${config.sportsengine.token}` : null,
    webhookVerified: !!config.sportsengine.secret,
    relayConfigured: !!config.draftBoardWebhookUrl,
  }
}

// ---------- divisions ----------
export interface DivisionInput {
  name: string; teams: number; roster_size: number; coaches?: number | null; min_age?: number | null; max_age?: number | null
  se_match?: string; forward?: boolean; closed?: boolean; notes?: string; sort?: number
}
export function saveDivision(id: string | null, d: DivisionInput, actor: string): Division {
  const name = d.name.trim()
  if (!name) throw new UserError('Division needs a name')
  if (d.min_age != null && d.max_age != null && d.min_age > d.max_age) throw new UserError('Youngest age is above oldest age')
  const vals = [name, d.teams, d.roster_size, d.coaches ?? null, d.min_age ?? null, d.max_age ?? null,
    (d.se_match ?? '').trim(), d.forward ? 1 : 0, d.closed ? 1 : 0, (d.notes ?? '').trim()]
  if (id) {
    const before = division(id)
    if (!before) throw new UserError('Unknown division')
    db.prepare(`UPDATE divisions SET name=?, teams=?, roster_size=?, coaches=?, min_age=?, max_age=?, se_match=?, forward=?, closed=?, notes=?,
      sort = COALESCE(?, sort) WHERE id = ?`).run(...vals, d.sort ?? null, id)
    audit(actor, 'division_saved', null, { division: name, teams: d.teams, roster: d.roster_size, closed: !!d.closed })
  } else {
    id = slug(name)
    while (division(id)) id = `${slug(name)}${uid().slice(0, 3)}`
    const sort = d.sort ?? ((db.prepare('SELECT MAX(sort) AS m FROM divisions').get() as { m: number | null }).m ?? 0) + 1
    db.prepare(`INSERT INTO divisions (name, teams, roster_size, coaches, min_age, max_age, se_match, forward, closed, notes, sort, id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...vals, sort, id)
    audit(actor, 'division_added', null, { division: name })
  }
  changed()
  return division(id)!
}
export function deleteDivision(id: string, actor: string) {
  const d = division(id)
  if (!d) throw new UserError('Unknown division')
  db.prepare('DELETE FROM divisions WHERE id = ?').run(id)
  audit(actor, 'division_deleted', null, { division: d.name })
  changed()
}
export function reorderDivisions(ids: string[], actor: string) {
  const up = db.prepare('UPDATE divisions SET sort = ? WHERE id = ?')
  db.transaction(() => ids.forEach((id, i) => up.run(i + 1, id)))()
  audit(actor, 'divisions_reordered', null, ids)
  changed()
}

// ---------- players ----------
export interface PlayerInput {
  name?: string; birthdate?: string | null; returner?: boolean; divisionId?: string | null; divisionLocked?: boolean
  status?: Status; locked?: boolean; notes?: string
}

export function upsertPlayer(id: string | null, p: PlayerInput, actor: string): Player {
  const before = id ? getPlayer(id) : undefined
  if (id && !before) throw new UserError('Unknown player')
  if (p.status && !STATUSES.includes(p.status)) throw new UserError('Unknown status')
  if (p.divisionId && !division(p.divisionId)) throw new UserError('Unknown division')
  const name = p.name?.trim()
  if (p.name !== undefined && !name) throw new UserError('Player needs a name')
  if (!before) {
    const nid = uid()
    const returner = p.returner ?? false
    db.prepare(`INSERT INTO players (id, name, name_key, birthdate, returner, division_id, division_locked, status, status_locked, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nid, name!, nameKey(name!), p.birthdate ?? null, returner ? 1 : 0,
      p.divisionId ?? null, p.divisionId ? 1 : 0, p.status ?? (returner ? 'Expected' : 'Registered'), p.locked ? 1 : 0, p.notes ?? '')
    audit(actor, 'player_added', nid, { name, division: p.divisionId ?? null })
    changed()
    return getPlayer(nid)!
  }
  const next = {
    name: name ?? before.name,
    birthdate: p.birthdate === undefined ? before.birthdate : p.birthdate,
    returner: p.returner === undefined ? before.returner : p.returner ? 1 : 0,
    status: p.status ?? before.status,
    status_locked: p.locked === undefined ? before.status_locked : p.locked ? 1 : 0,
    notes: p.notes ?? before.notes,
  }
  db.prepare(`UPDATE players SET name=?, name_key=?, birthdate=?, returner=?, status=?, status_locked=?, notes=?,
    registered_at = CASE WHEN ? = 'Registered' THEN COALESCE(registered_at, datetime('now')) ELSE registered_at END,
    updated_at=datetime('now') WHERE id=?`)
    .run(next.name, nameKey(next.name), next.birthdate, next.returner, next.status, next.status_locked, next.notes, next.status, id)
  const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => (before as unknown as Record<string, unknown>)[k] !== v)
    .map(([k, v]) => [k, { from: (before as unknown as Record<string, unknown>)[k], to: v }]))
  if (Object.keys(diff).length) audit(actor, 'player_edited', id, diff)
  if (p.divisionId !== undefined && p.divisionId !== before.division_id) movePlayer(id!, p.divisionId, actor)
  else if (p.divisionLocked !== undefined) {
    db.prepare('UPDATE players SET division_locked = ? WHERE id = ?').run(p.divisionLocked ? 1 : 0, id)
    audit(actor, p.divisionLocked ? 'division_pinned' : 'division_unpinned', id)
  }
  changed()
  return getPlayer(id!)!
}

/**
 * Admin moves a kid to another division (e.g. the family picked the wrong
 * program). The move is pinned, so a resent or re-run SportsEngine
 * registration won't put them back where the family originally chose.
 */
export function movePlayer(id: string, divisionId: string | null, actor: string, reason = ''): Player {
  const p = getPlayer(id)
  if (!p) throw new UserError('Unknown player')
  const to = divisionId ? division(divisionId) : undefined
  if (divisionId && !to) throw new UserError('Unknown division')
  const from = p.division_id ? division(p.division_id) : undefined
  db.prepare(`UPDATE players SET division_id = ?, division_locked = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(divisionId, divisionId ? 1 : 0, id)
  audit(actor, 'division_moved', id, { from: from?.name ?? null, to: to?.name ?? null, reason: reason || undefined })
  changed()
  return getPlayer(id)!
}

export function deletePlayer(id: string, actor: string) {
  const p = getPlayer(id)
  if (!p) throw new UserError('Unknown player')
  db.prepare('DELETE FROM players WHERE id = ?').run(id)
  audit(actor, 'player_deleted', null, { name: p.name })
  changed()
}

// ---------- last season's rosters ----------
const H = {
  name: ['name', 'player', 'playername', 'participant', 'participantname', 'athlete', 'fullname'],
  first: ['first', 'firstname', 'playerfirstname', 'participantfirstname'],
  last: ['last', 'lastname', 'playerlastname', 'participantlastname'],
  dob: ['dob', 'birthdate', 'dateofbirth', 'birthday', 'participantdob'],
  prior: ['division', 'league', 'lastdivision', 'priordivision', 'program', 'level', 'lastseason'],
  team: ['team', 'teamname', 'lastteam'],
  next: ['nextdivision', 'newdivision', 'placement', 'placein', 'nextseason'],
}
const hk = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export interface ImportResult { added: number; duplicates: number; agedOut: number; unplaced: number; byDivision: Record<string, number> }

/**
 * Paste last season's rosters (CSV or tab-separated from a spreadsheet, header
 * row required). Each kid becomes an Expected returner, placed in next
 * season's division by: an explicit "next division" column, else league age
 * against each division's age range, else the same division as last season.
 */
export function importReturners(text: string, actor: string, defaultDivisionId: string | null = null): ImportResult {
  const rows = parseCsv(text)
  if (rows.length < 2) throw new UserError('Paste a header row (e.g. Name, Birthdate, Division, Team) and at least one player')
  const head = rows[0]!.map(hk)
  const col = (keys: string[]) => head.findIndex((h) => keys.includes(h))
  const c = { name: col(H.name), first: col(H.first), last: col(H.last), dob: col(H.dob), prior: col(H.prior), team: col(H.team), next: col(H.next) }
  if (c.name < 0 && (c.first < 0 || c.last < 0)) throw new UserError('Need a Name column, or First and Last name columns')
  if (defaultDivisionId && !division(defaultDivisionId)) throw new UserError('Unknown division')

  const s = getSettings()
  const list = divisions()
  const oldest = Math.max(...list.map((d) => d.max_age ?? -1))
  const res: ImportResult = { added: 0, duplicates: 0, agedOut: 0, unplaced: 0, byDivision: {} }
  const ins = db.prepare(`INSERT INTO players (id, name, name_key, birthdate, returner, prior_division, division_id, status, notes)
    VALUES (?, ?, ?, ?, 1, ?, ?, 'Expected', '')`)
  db.transaction(() => {
    for (const r of rows.slice(1)) {
      const get = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '')
      const name = (c.name >= 0 ? get(c.name) : `${get(c.first)} ${get(c.last)}`).replace(/\s+/g, ' ').trim()
      if (!name) continue
      const dob = normDate(get(c.dob))
      const key = nameKey(name)
      const dups = db.prepare('SELECT birthdate FROM players WHERE name_key = ?').all(key) as { birthdate: string | null }[]
      if (dups.some((d) => !d.birthdate || !dob || d.birthdate === dob)) { res.duplicates++; continue }
      const age = ageFor(dob, s)
      if (age != null && oldest >= 0 && age > oldest) { res.agedOut++; continue }
      const priorName = get(c.prior)
      const prior = priorName ? divisionByName(priorName, list) : undefined
      const placed = (get(c.next) && divisionByName(get(c.next), list)) || divisionForAge(age, prior, list) || prior
        || (defaultDivisionId ? list.find((d) => d.id === defaultDivisionId) : undefined)
      const priorLabel = [priorName, get(c.team)].filter(Boolean).join(' · ')
      ins.run(uid(), name, key, dob, priorLabel, placed?.id ?? null)
      res.added++
      if (placed) res.byDivision[placed.name] = (res.byDivision[placed.name] ?? 0) + 1
      else res.unplaced++
    }
  })()
  audit(actor, 'returners_imported', null, res)
  changed()
  return res
}
