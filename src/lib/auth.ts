// M.2.b stub — all auth functions throw at runtime.
// Proper service-to-service auth (X-Service-Token) is wired in M.2.e.

export async function getSession(): Promise<null> {
  throw new Error(
    'Human auth not available in monitor. ' +
    'Service-to-service auth (X-Service-Token) lands in M.2.e.'
  )
}

export async function getUser(): Promise<null> {
  throw new Error(
    'Human auth not available in monitor. ' +
    'Service-to-service auth (X-Service-Token) lands in M.2.e.'
  )
}

export async function getProjectId(): Promise<string | null> {
  throw new Error(
    'getProjectId() not available in monitor until M.2.e middleware.'
  )
}

export async function requireAuth(): Promise<{ id: string }> {
  throw new Error(
    'Human auth not available in monitor. ' +
    'Service-to-service auth (X-Service-Token) lands in M.2.e.'
  )
}
