import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const env = process.env
export const isProd = env.NODE_ENV === 'production'

export const config = {
  port: Number(env.PORT) || 3040,
  baseUrl: (env.BASE_URL || `http://localhost:${Number(env.PORT) || 3040}`).replace(/\/$/, ''),
  dbPath: env.DB_PATH || path.join(ROOT, 'data', 'registration.db'),
  // Admin logins shared with the other league tools (see src/lib/authdb.ts).
  authDbPath: env.AUTH_DB_PATH || path.join(path.dirname(env.DB_PATH || path.join(ROOT, 'data', 'x.db')), 'auth.db'),
  // e.g. .crushworldseries.com, so logging into one league tool logs into all of them.
  cookieDomain: env.COOKIE_DOMAIN || '',
  viewerPassword: env.VIEWER_PASSWORD || '',
  sportsengine: {
    token: env.SPORTSENGINE_WEBHOOK_TOKEN || '',
    secret: env.SPORTSENGINE_WEBHOOK_SECRET || '',
    signatureHeader: (env.SPORTSENGINE_SIGNATURE_HEADER || 'x-sportsengine-signature').toLowerCase(),
  },
  // Registrations placed in a division marked "forward" are relayed here, so
  // SportsEngine only needs one webhook URL for every league tool.
  draftBoardWebhookUrl: env.DRAFT_BOARD_WEBHOOK_URL || '',
  draftBoardUrl: (env.DRAFT_BOARD_URL || '').replace(/\/$/, ''),
}
