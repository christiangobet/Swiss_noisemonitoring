import { NextRequest, NextResponse } from 'next/server'
import { unsealData } from 'iron-session'
import { SessionData, sessionOptions } from '@/lib/session'

const PUBLIC_PREFIXES = ['/login', '/api/auth/', '/api/ingest']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  if (PUBLIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const cookieValue = request.cookies.get('tramwatch-session')?.value
  if (!cookieValue) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  try {
    const session = await unsealData<SessionData>(cookieValue, {
      password: sessionOptions.password as string,
    })
    if (!session.authenticated) {
      return NextResponse.redirect(new URL('/login', request.url))
    }
  } catch {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
