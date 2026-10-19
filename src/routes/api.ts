import { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../config.js'
import { db } from '../db.js'
import {
  clearFailures, grantViewer, login, logout, noteFailure, requireAdmin, requireViewer, throttled,
} from '../lib/auth.js'
import * as L from '../lib/league.js'
import { STATUSES } from '../lib/text.js'
import { ignoreRegistration, importRegistrationCsv, placeRegistration, processRegistration, relay, storeRegistration } from '../lib/sportsengine.js'

export const api = Router()
const actor = (req: Request) => req.admin?.username ?? 'unknown'
type H = (req: Request, res: Response) => unknown
const wrap = (fn: H) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const out = await fn(req, res)
    if (!res.headersSent) res.json(out ?? { ok: true })
  } catch (e) {
    if (e instanceof L.UserError || e instanceof z.ZodError) {
      return res.status(400).json({ error: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : e.message })
    }
    next(e)
  }
}
const asUser = <T>(fn: () => T): T => { try { return fn() } catch (e) { throw e instanceof L.UserError ? e : new L.UserError((e as Error).message) } }

const csv = (rows: (string | number | null | undefined)[][]) =>
  rows.map((r) => r.map((v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''))).join(',')).join('\n')
function sendCsv(res: Response, name: string, rows: (string | number | null | undefined)[][]) {
  res.set('Content-Type', 'text/csv; charset=utf-8')
  res.set('Content-Disposition', `attachment; filename="${name}"`)
  res.send(csv(rows))
}

// ---------- session ----------
api.get('/api/me', (req, res) => {
  res.json({ admin: req.admin?.username ?? null, viewer: !!req.viewer, viewerCodeRequired: !!config.viewerPassword })
})
api.post('/api/login', wrap((req, res) => {
  const { username, password } = z.object({ username: z.string().min(1), password: z.string().min(1) }).parse(req.body)
  const key = `login:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' })
  if (!login(res, username, password)) { noteFailure(key); return res.status(401).json({ error: 'Wrong username or password' }) }
  clearFailures(key)
}))
api.post('/api/logout', wrap((req, res) => { logout(req, res) }))
api.post('/api/viewer', wrap((req, res) => {
  const { code } = z.object({ code: z.string() }).parse(req.body)
  const key = `viewer:${req.ip}`
  if (throttled(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' })
  if (!config.viewerPassword || code.trim() !== config.viewerPassword) { noteFailure(key); return res.status(401).json({ error: 'That code isn’t right' }) }
  clearFailures(key)
  grantViewer(res)
}))

// ---------- overview (numbers only, no names) ----------
api.get('/api/state', requireViewer, (req, res) => { res.json(L.publicState(!!req.admin)) })

api.get('/api/stream', requireViewer, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const send = (v: number) => res.write(`event: change\ndata: ${v}\n\n`)
  send(L.currentVersion())
  L.bus.on('change', send)
  const ping = setInterval(() => res.write(': ping\n\n'), 25e3)
  req.on('close', () => { clearInterval(ping); L.bus.off('change', send) })
})

api.get('/api/capacity.csv', requireViewer, (_req, res) => {
  const st = L.publicState(false)
  sendCsv(res, `${st.settings.season}-registration-capacity.csv`, [
    ['Division', 'Teams', 'Roster size', 'Capacity', 'Registered', 'Returners registered', 'New registered', 'Returners expected', 'Returners need contact', 'Open seats', 'Waitlist', 'Status'],
    ...st.divisions.map((d) => [d.name, d.teams, d.roster_size, d.seats.capacity, d.seats.registered, d.seats.returnersRegistered, d.seats.newRegistered,
      d.seats.expected, d.seats.atRisk, d.seats.open, d.seats.waitlist, d.closed ? 'Closed' : d.seats.state]),
  ])
})

// ---------- admin ----------
const admin = Router()
admin.use(requireAdmin)
api.use('/api/admin', admin)

const optInt = z.union([z.number().int().min(0).max(99), z.null()]).optional()
const divisionBody = z.object({
  name: z.string().min(1).max(60),
  teams: z.number().int().min(0).max(60),
  roster_size: z.number().int().min(1).max(40),
  coaches: optInt, min_age: optInt, max_age: optInt,
  se_match: z.string().max(300).optional(),
  forward: z.boolean().optional(),
  closed: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
})
admin.post('/divisions', wrap((req) => L.saveDivision(null, divisionBody.parse(req.body), actor(req))))
admin.patch('/divisions/:id', wrap((req) => L.saveDivision(String(req.params.id), divisionBody.parse(req.body), actor(req))))
admin.delete('/divisions/:id', wrap((req) => { L.deleteDivision(String(req.params.id), actor(req)) }))
admin.put('/divisions/order', wrap((req) => { L.reorderDivisions(z.object({ order: z.array(z.string()) }).parse(req.body).order, actor(req)) }))

const playerBody = z.object({
  name: z.string().max(120).optional(),
  birthdate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]).optional(),
  returner: z.boolean().optional(),
  divisionId: z.union([z.string(), z.null()]).optional(),
  divisionLocked: z.boolean().optional(),
  status: z.enum(STATUSES).optional(),
  locked: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
})
admin.post('/players', wrap((req) => L.upsertPlayer(null, playerBody.extend({ name: z.string().min(1).max(120) }).parse(req.body), actor(req))))
admin.patch('/players/:id', wrap((req) => L.upsertPlayer(String(req.params.id), playerBody.parse(req.body), actor(req))))
admin.delete('/players/:id', wrap((req) => { L.deletePlayer(String(req.params.id), actor(req)) }))
// Move one or many kids to another division (wrong program picked, playing up, ...).
admin.post('/players/move', wrap((req) => {
  const b = z.object({ ids: z.array(z.string()).min(1).max(500), divisionId: z.union([z.string(), z.null()]), reason: z.string().max(300).optional() }).parse(req.body)
  db.transaction(() => b.ids.forEach((id) => L.movePlayer(id, b.divisionId, actor(req), b.reason)))()
  const to = b.divisionId ? L.division(b.divisionId)?.name : 'no division'
  return { ok: true, message: `Moved ${b.ids.length} ${b.ids.length === 1 ? 'player' : 'players'} to ${to}` }
}))
admin.get('/players/:id/history', wrap((req) => ({
  audit: db.prepare('SELECT * FROM audit WHERE player_id = ? ORDER BY id DESC LIMIT 100').all(String(req.params.id)),
  registrations: db.prepare('SELECT id, received_at, source, program, outcome, note FROM registrations WHERE player_id = ? ORDER BY id DESC').all(String(req.params.id)),
})))
admin.post('/returners/import', wrap((req) => {
  const b = z.object({ text: z.string().max(2_000_000), divisionId: z.union([z.string(), z.null()]).optional() }).parse(req.body)
  return L.importReturners(b.text, actor(req), b.divisionId ?? null)
}))
api.get('/api/admin/players.csv', requireAdmin, (_req, res) => {
  const st = L.publicState(true) as ReturnType<typeof L.publicState> & { players: (L.Player & { age: number | null })[] }
  const dn = new Map(st.divisions.map((d) => [d.id, d.name]))
  sendCsv(res, `${st.settings.season}-players.csv`, [
    ['Division', 'Player', 'League age', 'Birthdate', 'Returning', 'Last season', 'Status', 'SE program', 'Notes'],
    ...st.players.map((p) => [dn.get(p.division_id ?? '') ?? '', p.name, p.age, p.birthdate, p.returner ? 'Yes' : 'No', p.prior_division, p.status, p.se_program, p.notes]),
  ])
})

const settingsBody = z.object({
  season: z.string().max(20).optional(),
  registrationYear: z.number().int().min(2000).max(2100).optional(),
  ageCutoff: z.string().regex(/^\d{2}-\d{2}$/).optional(),
  warnAt: z.number().int().min(0).max(50).optional(),
})
admin.patch('/settings', wrap((req) => {
  const p = settingsBody.parse(req.body)
  L.setSettings(p)
  L.audit(actor(req), 'settings_changed', null, p)
  L.changed()
}))

// ---------- registrations inbox ----------
const OPEN = `('no_division','ambiguous','error','pending')`
admin.get('/registrations', wrap((req) => {
  const filter = String(req.query.filter ?? 'open')
  const where = filter === 'open' ? `WHERE outcome IN ${OPEN}` : filter === 'relay' ? `WHERE forwarded LIKE 'failed%'` : filter === 'all' ? '' : `WHERE outcome = ?`
  const args = ['open', 'all', 'relay'].includes(filter) ? [] : [filter]
  const rows = db.prepare(`SELECT r.id, r.received_at, r.source, r.event_type, r.verified, r.first_name, r.last_name, r.birthdate, r.reg_year,
      r.program, r.outcome, r.note, r.player_id, r.forwarded, p.name AS player_name, d.name AS division_name
    FROM registrations r LEFT JOIN players p ON p.id = r.player_id LEFT JOIN divisions d ON d.id = r.division_id
    ${where} ORDER BY r.id DESC LIMIT 500`).all(...args)
  const counts = Object.fromEntries((db.prepare('SELECT outcome, COUNT(*) n FROM registrations GROUP BY outcome').all() as { outcome: string; n: number }[]).map((r) => [r.outcome, r.n]))
  counts.relay = (db.prepare(`SELECT COUNT(*) n FROM registrations WHERE forwarded LIKE 'failed%'`).get() as { n: number }).n
  const se = config.sportsengine
  return {
    rows, counts,
    webhook: { configured: !!se.token, url: se.token ? `${config.baseUrl}/webhooks/sportsengine/${se.token}` : null, signed: !!se.secret, signatureHeader: se.signatureHeader },
    relayConfigured: !!config.draftBoardWebhookUrl,
  }
}))
admin.get('/registrations/:id', wrap((req) => db.prepare('SELECT * FROM registrations WHERE id = ?').get(Number(req.params.id))))
admin.post('/registrations/:id/reprocess', wrap((req) => processRegistration(Number(req.params.id), actor(req))))
admin.post('/registrations/reprocess-open', wrap((req) => {
  const ids = db.prepare(`SELECT id FROM registrations WHERE outcome IN ${OPEN}`).all() as { id: number }[]
  const tally: Record<string, number> = {}
  for (const { id } of ids) { const r = processRegistration(id, actor(req)); tally[r.outcome] = (tally[r.outcome] ?? 0) + 1 }
  return tally
}))
admin.post('/registrations/:id/place', wrap((req) => {
  const b = z.object({ playerId: z.union([z.string(), z.null()]).optional(), divisionId: z.union([z.string(), z.null()]).optional() }).parse(req.body)
  return asUser(() => placeRegistration(Number(req.params.id), b, actor(req)))
}))
admin.post('/registrations/:id/ignore', wrap((req) => { ignoreRegistration(Number(req.params.id), actor(req)) }))
admin.post('/registrations/:id/relay', wrap(async (req) => {
  if (!config.draftBoardWebhookUrl) throw new L.UserError('DRAFT_BOARD_WEBHOOK_URL is not set')
  const r = await relay(Number(req.params.id))
  if (r !== 'ok') throw new L.UserError(`Draft board relay ${r}`)
  return { ok: true, message: 'Sent to the draft board' }
}))
admin.post('/registrations/import', wrap((req) => {
  const { text } = z.object({ text: z.string().max(4_000_000) }).parse(req.body)
  return asUser(() => importRegistrationCsv(text, actor(req)))
}))
// Manual single registration, for a paper form or for testing placement.
admin.post('/registrations/manual', wrap((req) => {
  const b = z.object({ firstName: z.string().min(1), lastName: z.string().min(1), birthdate: z.string().optional(), program: z.string().optional() }).parse(req.body)
  const payload = { participant: { first_name: b.firstName, last_name: b.lastName, date_of_birth: b.birthdate }, program: b.program, season: String(L.getSettings().registrationYear) }
  const { id } = storeRegistration('manual', JSON.stringify(payload), payload, true)
  return processRegistration(id, actor(req))
}))

admin.get('/audit', wrap(() => db.prepare(`SELECT a.*, p.name AS player_name FROM audit a LEFT JOIN players p ON p.id = a.player_id ORDER BY a.id DESC LIMIT 300`).all()))
