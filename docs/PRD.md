# Flutter Intelligence MCP

## Goal

Provide Claude Code, Cursor, Codex and Gemini with live Flutter runtime context.

Instead of parsing logs, expose structured runtime data and AI diagnosis through MCP tools.

---

## Target Users

Flutter Developers

Senior Engineers

AI Coding Agents

QA Engineers

Performance Engineers

---

## Problems

Developers currently copy:

- flutter logs
- DevTools screenshots
- stack traces
- network logs

into AI chats.

AI has no live runtime context.

---

## Solution

Create an MCP server that connects to Flutter VM Service and exposes runtime tools.

---

## v0 Features

✅ Connect to VM Service

✅ Read console logs

✅ Read latest exceptions

✅ Read network requests

✅ Read frame timings

✅ Diagnose runtime

---

## Future

Widget Inspector

Timeline

Memory

CPU

Widget rebuilds

OpenTelemetry

Knowledge Graph

Regression Detection

Auto Fixes