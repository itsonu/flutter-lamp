# Security Policy

## Reporting a vulnerability

Report privately through
[GitHub Security Advisories](https://github.com/itsonu/flutter-lamp/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you can: affected version, what an attacker gains, and a
reproduction. Expect an acknowledgement within a week. Fixes ship as a patch
release with credit, unless you would rather not be named.

## Supported versions

The latest minor release. This project is pre-1.0; there are no backports.

## Threat model

Flutter Lamp reads a running Flutter app over the Dart VM Service and hands the
result to two consumers: an AI agent over MCP stdio, and any browser watching
the dashboard. Both are exit paths for data that started out inside your app.

Assumed trusted: the machine it runs on, the developer running it, and the
Flutter app being debugged. Assumed hostile: any other page open in the
developer's browser, and anything reachable on the network if the dashboard is
deliberately unbound from loopback.

## What is protected

**Credential redaction at capture.** Secrets are stripped before an event
enters the store, so no consumer — current or future, including session export
— can leak what was never written. Covered: `Authorization`,
`Proxy-Authorization`, `Cookie`, `Set-Cookie`, `WWW-Authenticate`, headers whose
name contains `token`, `secret`, `password`, `credential`, `api-key` or
`session`, sensitive query-string parameters, and JWT- or `Bearer`-shaped
strings in log and error text.

**Dashboard WebSocket authentication.** Loopback binding alone does not protect
a WebSocket: browsers exempt WebSocket from the same-origin policy and send no
preflight, so an unprotected endpoint on `127.0.0.1` is readable by any page the
developer has open. The handshake requires a per-process token that only
same-origin script can read, and a present `Origin` must be loopback.

**No VM Service URI over HTTP.** That URI embeds the VM's auth token, so
`/health` returns liveness only.

**Read-only against the app.** Runtime inspection does not modify your project.
Two operations do change VM or app state and are documented as such: enabling
`httpEnableTimelineLogging` at connect, and `get_timeline` with
`recordFrom: true`.

## What is not protected

Anything on the machine itself. A local process running as your user can read
the dashboard, the MCP stdio stream, and the VM Service directly — Flutter Lamp
does not defend against local privilege boundaries it cannot see.

Setting `DASHBOARD_HOST` to a non-loopback address. That is an explicit opt-in,
it logs a warning, and it puts runtime evidence on your network.

Running with `FLUTTER_LAMP_REDACT=off`. That is also an explicit opt-in.

Whatever your MCP client does with the data after Flutter Lamp returns it. If
the client sends tool results to a hosted model, your runtime evidence goes with
them. Redaction reduces what is in those results; it does not control where they
travel.
