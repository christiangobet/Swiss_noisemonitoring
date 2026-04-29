export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getIronSession } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/session'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const pin  = typeof body.pin === 'string' ? body.pin : ''

  if (!pin || pin !== process.env.APP_PIN) {
    return NextResponse.json({ error: 'Incorrect PIN' }, { status: 401 })
  }

  const res     = NextResponse.json({ ok: true })
  const session = await getIronSession<SessionData>(req, res, sessionOptions)
  session.authenticated = true
  await session.save()
  return res
}
