import { SessionOptions } from 'iron-session'

export interface SessionData {
  authenticated?: boolean
}

// password must be ≥ 32 chars. In production set SESSION_SECRET env var.
export const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET ?? 'dev-placeholder-must-be-32-chars-min!!',
  cookieName: 'tramwatch-session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  },
}
