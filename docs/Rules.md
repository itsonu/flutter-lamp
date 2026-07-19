# Rules

Always use official Flutter VM Service APIs.

Never scrape DevTools HTML.

Never parse screenshots.

Prefer structured JSON.

Every event must have

- timestamp

- source

- severity

- category

Never lose runtime history.

Every diagnosis must include

- confidence

- evidence

- fixes

Never hallucinate.

If confidence <70%

Say Unknown.

Use TypeScript.

Use MCP SDK.

No polling.

Prefer WebSocket subscriptions.

Every tool must be stateless.

Runtime cache is centralized.

Log everything.

Return JSON only.