import { NextResponse } from 'next/server'
import { SOURCES_CATALOG } from '@/lib/sources-catalog'

// Global catalog of supported alert sources. Auth (X-Service-Token) is
// enforced by src/middleware.ts; /api/v1/sources is exempt from the
// X-Grauss-Project-Id requirement (M.2.h) because the catalog is not
// per-project.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ sources: SOURCES_CATALOG })
}
