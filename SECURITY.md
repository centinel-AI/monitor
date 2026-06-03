# Security Policy

## Supported versions

Only the latest version of monitor on the `main` branch receives security fixes.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

If you discover a security issue — including authentication bypasses, secret exposure,
injection in alert ingestion, or insecure defaults — please report it privately:

1. Email the maintainers at the address listed in the repository profile, or
2. Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability) if enabled for this repository.

Include as much detail as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof of concept
- The affected version or commit (`git rev-parse HEAD`)
- Any relevant request/payload or configuration (redact real tokens, keys, and credentials)

## Response timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | Within 3 business days |
| Initial assessment | Within 7 business days |
| Fix or mitigation | Depends on severity — critical issues are prioritised |

## Scope

This policy covers:

- The HTTP API and route handlers (`src/app/api/`), including service-to-service
  authentication (`X-Service-Token`) and webhook token handling
- Alert ingestion and normalizers (parsing of untrusted external payloads)
- Handling of secrets at rest — per-project BYOK keys encrypted with `MASTER_ENCRYPTION_KEY`
- The background pipeline and job queue (pg-boss)

Out of scope:

- Vulnerabilities in Next.js, Node.js, PostgreSQL, pgvector, pg-boss, or other
  dependencies themselves — report those to the respective maintainers
- Issues in third-party services monitor integrates with (Anthropic, OpenAI, Slack,
  Resend) or in cloud provider APIs — report those to the respective vendor
- Findings from automated scanners without a demonstrated impact

## Disclosure

Once a fix is available, we will publish a security advisory describing the vulnerability,
its impact, and the remediation steps. Credit will be given to the reporter unless they
prefer to remain anonymous.
