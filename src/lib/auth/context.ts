import { headers } from 'next/headers'

/**
 * Returns the projectId injected by the middleware after validating
 * X-Service-Token + X-Grauss-Project-Id.
 * Throws if called from a route not covered by the middleware.
 */
export async function getProjectId(): Promise<string> {
  const h = await headers()
  const projectId = h.get('x-monitor-project-id')
  if (!projectId) {
    throw new Error(
      'getProjectId() called from a route not protected by service-token middleware'
    )
  }
  return projectId
}

/**
 * Returns null instead of throwing, for optionally-protected routes.
 */
export async function getOptionalProjectId(): Promise<string | null> {
  const h = await headers()
  return h.get('x-monitor-project-id')
}
