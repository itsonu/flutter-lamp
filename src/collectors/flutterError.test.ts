import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFlutterError } from "./flutterError.js";

// Shape modeled on a real serialized FlutterErrorDetails.toJson():
// nested DiagnosticsNode with an ErrorSummary, a widget header, and a run of
// stack-frame nodes.
const FIXTURE = {
  description: "",
  type: "FlutterErrorDetails",
  library: "widgets library",
  level: "error",
  properties: [
    {
      description: "The following assertion was thrown building MyHomePage:",
      level: "summary",
      type: "ErrorSummary",
    },
    { description: "RenderBox was not laid out: RenderFlex#a1b2 NEEDS-LAYOUT" },
    { description: "The relevant error-causing widget was:" },
    { description: "Column Column:file:///lib/main.dart:42:12" },
    { description: "When the exception was thrown, this was the stack:" },
    { description: "#0      RenderBox.size (package:flutter/src/rendering/box.dart:2001:12)" },
    { description: "#1      RenderFlex.performLayout (package:flutter/src/rendering/flex.dart:800:5)" },
    { description: "<asynchronous suspension>" },
    { description: "#2      main (package:my_app/main.dart:10:3)" },
  ],
};

test("extracts summary, library, widget, and full stack from Flutter.Error", () => {
  const e = extractFlutterError(FIXTURE);
  assert.equal(e.summary, "The following assertion was thrown building MyHomePage:");
  assert.equal(e.library, "widgets library");
  assert.equal(e.type, "FlutterErrorDetails");
  assert.equal(e.widget, "Column Column:file:///lib/main.dart:42:12");
  const lines = e.stack.split("\n");
  assert.equal(lines[0], "#0      RenderBox.size (package:flutter/src/rendering/box.dart:2001:12)");
  assert.equal(lines[1], "#1      RenderFlex.performLayout (package:flutter/src/rendering/flex.dart:800:5)");
  assert.ok(e.stack.includes("<asynchronous suspension>"));
  assert.equal(lines[3], "#2      main (package:my_app/main.dart:10:3)");
});

test("nested children stacks are also collected", () => {
  const nested = {
    type: "FlutterErrorDetails",
    children: [
      { description: "Bad state: no element", level: "summary", type: "ErrorSummary" },
      { children: [{ description: "#0      foo (package:x/x.dart:1:1)" }] },
    ],
  };
  const e = extractFlutterError(nested);
  assert.equal(e.summary, "Bad state: no element");
  assert.equal(e.stack, "#0      foo (package:x/x.dart:1:1)");
});

test("degrades gracefully with no stack", () => {
  const e = extractFlutterError({ description: "Something went wrong", type: "FlutterErrorDetails" });
  assert.equal(e.summary, "Something went wrong");
  assert.equal(e.stack, "");
});
