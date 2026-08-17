# AGENT-OS local control-plane threat model

Status: Wave 1 foundation. This contract protects Workbench routes only. Direct
provider routes remain outside this Wave and must not be presented as protected
by these controls.

## Assets and trust boundary

The Workbench controls local agent runs, approvals, event streams, tools, and
workspace context. Possession of a desktop OS account alone is not treated as
authorization to mutate that state. The boundary therefore includes hostile web
origins, DNS rebinding, a hostile local process able to call loopback, replayed
HTTP requests, malformed or oversized bodies, and stale browser sessions.

TLS is not required for loopback HTTP. Confidentiality against a process that
can read another process's memory or browser cookie store is an operating-system
boundary and is not claimed here.

## HTTP contract

- The framework request URL must use HTTP(S) and a loopback hostname. Its
  hostname is not used as the client authority because Next.js can normalize a
  legitimate `127.0.0.1` request to the `localhost` alias. The raw `Host` header
  is parsed independently and must be loopback; forwarded-host headers are not
  trusted. For POST and SSE, that `Host` authority must exactly match `Origin`
  by scheme, hostname, and effective port. Suffixes and alternate hosts are
  denied.
- Mutations and SSE require an exact serialized `Origin` match, including scheme,
  hostname, and effective port. Cross-site Fetch Metadata is denied.
- JSON mutation bodies must use `application/json`. `Content-Length` is checked
  before reading, and streamed bytes are capped at 64 KiB by default (1 KiB for
  bootstrap). Invalid, array, and primitive JSON bodies are denied.
- Read-only Workbench GETs retain the loopback boundary. SSE is not treated as an
  ordinary read because it can expose a durable event stream.

## Browser session and replay control

Initial issuance is `POST /api/workbench/session`. It requires the exact local
HTTP boundary plus `AGENT_OS_WORKBENCH_BOOTSTRAP_SECRET` through the
`X-Agent-OS-Bootstrap-Token` header. The configured secret must have at least 32
characters. Missing configuration, missing tokens, and incorrect tokens fail
closed. The secret is never returned in a body or cookie and is never logged by
the session code.

The response sets host-only, `HttpOnly`, `SameSite=Strict` cookies scoped to
`/api/workbench`. HTTPS additionally sets `Secure`. Sessions are bound to the
exact app origin, expire after 15 minutes by default, and are invalidated by a
server restart. `GET /api/workbench/session` requires a valid session and rotates
both its opaque session secret and its next mutation secret; old session tokens
immediately fail.

Every Workbench mutation atomically consumes its one-shot mutation token before
route side effects. Reuse and concurrent replay fail. A client must rotate the
session to obtain the next `HttpOnly` mutation cookie. SSE requires the live
session cookie but does not consume the one-shot mutation token.

## Bootstrap deployment constraint

Browser issuance requires a private launcher/server bootstrap channel capable of
injecting the bootstrap header without exposing its value to page JavaScript,
responses, URLs, or logs. Until that channel and the Workbench UI client are
connected in Wave 3, UI mutation exposure must remain disabled. There is no
Fetch-Metadata or native-client bypass: an untrusted local process without the
bootstrap secret or browser tokens is denied.

## Deferred controls

Provider routes, project/path containment, minimal child environments, Windows
Job Objects, executable hashes, policy, approvals, and layered secret redaction
have separate Wave 1 work items. This document does not claim those gates have
passed. `start` must remain unavailable until every Wave 1 exit requirement is
proven.
