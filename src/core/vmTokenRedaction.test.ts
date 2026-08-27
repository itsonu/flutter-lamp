import { test } from "node:test";
import assert from "node:assert/strict";
import { redactionEnabled, redactText, reloadRedactionConfig, setSessionToken } from "./redaction.js";

/**
 * The VM Service credential must not survive in captured text.
 *
 * The path segment of a VM Service URI authorises `evaluate` — arbitrary Dart
 * execution in the app being observed. 0.18.1 stopped this server leaking it in
 * its own output. This covers the other direction, found on a web target: the
 * app's first console line is its own debug-service URI, and the log collector
 * stored it verbatim, from where it travelled into `get_logs`, into
 * `export_session`, and into anything a developer pasted.
 */

const REAL = "This app is linked to the debug service: ws://127.0.0.1:60106/Qb8P6JpYTRk=/ws";

test("the session's own token is scrubbed wherever it appears", () => {
  setSessionToken("ws://127.0.0.1:60106/Qb8P6JpYTRk=/ws");
  try {
    const out = redactText(REAL);
    assert.ok(!out.includes("Qb8P6JpYTRk"), `token survived: ${out}`);
    assert.match(out, /\[REDACTED\]/);
    // The shape stays readable — the point is to mask the credential, not to
    // destroy the evidence that the app announced a debug service.
    assert.match(out, /ws:\/\/127\.0\.0\.1:60106\//);

    // Also in the http form flutter prints, which has no /ws suffix to match on.
    const http = redactText("DevTools at http://127.0.0.1:60106/Qb8P6JpYTRk=/devtools/");
    assert.ok(!http.includes("Qb8P6JpYTRk"), `token survived in http form: ${http}`);
  } finally {
    setSessionToken(null);
  }
});

test("an unknown VM Service URI in text is still masked", () => {
  setSessionToken(null);
  const out = redactText("peer reported ws://10.0.0.5:8181/SomeOtherToken=/ws");
  assert.ok(!out.includes("SomeOtherToken"), `token survived: ${out}`);
});

test("ordinary websocket URLs keep their path", () => {
  setSessionToken(null);
  // Over-redaction destroys evidence. Only the VM Service shape is masked.
  const out = redactText("connecting to ws://api.example.com/v1/socket for updates");
  assert.equal(out, "connecting to ws://api.example.com/v1/socket for updates");
});

test("a short path segment is not treated as a token", () => {
  // Masking a 2-character segment globally would gut the logs.
  setSessionToken("ws://127.0.0.1:8181/ab/ws");
  try {
    const out = redactText("the letters ab appear in ordinary prose");
    assert.equal(out, "the letters ab appear in ordinary prose");
  } finally {
    setSessionToken(null);
  }
});

test("FLUTTER_LAMP_REDACT=off does not hand out the token", () => {
  // That switch exists so a developer can read their own app's headers and log
  // text. This is the key to the app being debugged, and no switch releases it.
  const prev = process.env.FLUTTER_LAMP_REDACT;
  process.env.FLUTTER_LAMP_REDACT = "off";
  // The config is read once at import, so setting the variable alone changes
  // nothing — without this reload the test passes while exercising the *enabled*
  // path, which is worse than having no test at all.
  reloadRedactionConfig();
  setSessionToken("ws://127.0.0.1:60106/Qb8P6JpYTRk=/ws");
  try {
    assert.equal(redactionEnabled(), false, "the off switch must actually be off here");
    const out = redactText(REAL);
    assert.ok(!out.includes("Qb8P6JpYTRk"), `token survived with redaction off: ${out}`);
  } finally {
    setSessionToken(null);
    if (prev === undefined) delete process.env.FLUTTER_LAMP_REDACT;
    else process.env.FLUTTER_LAMP_REDACT = prev;
    reloadRedactionConfig();
  }
});
