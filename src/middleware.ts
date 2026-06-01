// Service-to-service auth middleware for monitor.
// All /api/* and /api/v1/* routes require X-Service-Token + X-Grauss-Project-Id
// except the paths listed below that authenticate via their own mechanism.
//
// The middleware injects x-monitor-project-id into the request headers so
// handlers can read it via getProjectId() without re-validating the token.

import { NextResponse, type NextRequest } from 'next/server'

const PUBLIC_PATHS = ['/api/health', '/api/install']

const SELF_AUTH_PATHS = [
  '/api/webhooks/',     // bearer token per project
  '/api/slack/actions', // Slack signing secret
]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isPublic(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(p + '/'))
}
function hasSelfAuth(path: string): boolean {
  return SELF_AUTH_PATHS.some((p) => path.startsWith(p))
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (!pathname.startsWith('/api/')) return NextResponse.next()
  if (isPublic(pathname)) return NextResponse.next()
  if (hasSelfAuth(pathname)) return NextResponse.next()

  const expected = process.env.MONITOR_SERVICE_TOKEN
  if (!expected) {
    console.error('[middleware] MONITOR_SERVICE_TOKEN not configured')
    return NextResponse.json({ error: 'service token not configured' }, { status: 500 })
  }

  const token = req.headers.get('x-service-token')
  if (!token || token !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const projectId = req.headers.get('x-grauss-project-id')
  if (!projectId || !UUID_RE.test(projectId)) {
    return NextResponse.json({ error: 'missing or invalid x-grauss-project-id' }, { status: 400 })
  }

  const reqHeaders = new Headers(req.headers)
  reqHeaders.set('x-monitor-project-id', projectId)
  return NextResponse.next({ request: { headers: reqHeaders } })
}

export const config = {
  matcher: ['/api/:path*'],
}
