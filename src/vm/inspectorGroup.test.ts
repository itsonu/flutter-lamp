import { test } from "node:test";
import assert from "node:assert/strict";
import { withInspectorGroup, type IsolateCall } from "./inspectorGroup.js";
import { readFileSync } from "node:fs";

/** Records every RPC so the test can assert the group was released. */
function recorder(behaviour: IsolateCall = async () => ({})) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const call: IsolateCall = async (method, params) => {
    calls.push({ method, params });
    return behaviour(method, params);
  };
  const disposed = () =>
    calls
      .filter((c) => c.method === "ext.flutter.inspector.disposeGroup")
      .map((c) => c.params?.objectGroup);
  return { call, calls, disposed };
}

test("the object group is disposed after a successful read", async () => {
  const rec = recorder();
  const seen: string[] = [];

  const result = await withInspectorGroup(rec.call, async (groupName) => {
    seen.push(groupName);
    return "tree";
  });

  assert.equal(result, "tree");
  assert.deepEqual(rec.disposed(), seen, "the group used must be the group released");
});

test("the object group is disposed when the read throws", async () => {
  const rec = recorder();
  let used = "";

  await assert.rejects(
    withInspectorGroup(rec.call, async (groupName) => {
      used = groupName;
      throw new Error("inspector unavailable");
    }),
    /inspector unavailable/,
  );

  assert.deepEqual(rec.disposed(), [used], "a failed read must not leak the group");
});

test("a failing dispose does not turn a successful read into an error", async () => {
  const rec = recorder(async (method) => {
    if (method === "ext.flutter.inspector.disposeGroup") throw new Error("app went away");
    return {};
  });

  assert.equal(await withInspectorGroup(rec.call, async () => "tree"), "tree");
  assert.equal(rec.disposed().length, 1, "dispose was still attempted");
});

test("each call gets its own group, so calls cannot free each other's nodes", async () => {
  const rec = recorder();
  const first = await withInspectorGroup(rec.call, async (g) => g);
  const second = await withInspectorGroup(rec.call, async (g) => g);

  assert.notEqual(first, second);
  assert.deepEqual(rec.disposed(), [first, second]);
});

/**
 * Flutter names the object group `objectGroup`, and it is not forgiving about
 * it. `getRootWidgetSummaryTree` is registered through
 * `_registerObjectGroupServiceExtension`, which reads `parameters['objectGroup']!`;
 * `getSelectedSummaryWidget` goes through `_registerServiceExtensionWithArg`,
 * which does `assert(parameters.containsKey('objectGroup'))`. Either way a
 * missing key throws *inside the observed app* — so getting this wrong does not
 * merely fail the read, it injects an exception into the evidence being
 * collected.
 *
 * It was wrong: the call sites sent `groupName` while `disposeGroup` correctly
 * sent `objectGroup`, and every mock-based test passed because a mock does not
 * care what a parameter is called. Found by running against a real app.
 *
 * This reads the source because the failure mode is a wrong string literal in a
 * call the unit tests cannot reach — `registerTools` holds a connection
 * singleton, and refactoring it for injectability costs more than it protects.
 */
test("every inspector call names the object group the way Flutter requires", () => {
  const sources = ["src/tools.ts", "src/vm/inspectorGroup.ts", "src/collectors/rebuildCollector.ts"];

  for (const file of sources) {
    const text = readFileSync(file, "utf8");
    assert.ok(
      !/groupName\s*[,}]/.test(text.replace(/objectGroup:\s*groupName/g, "")),
      `${file} passes a bare \`groupName\` to an inspector RPC; Flutter requires \`objectGroup\``,
    );
  }
});

test("the inspector RPCs that take a group are called with objectGroup", () => {
  const text = readFileSync("src/tools.ts", "utf8");

  for (const rpc of ["getRootWidgetSummaryTree", "getSelectedSummaryWidget"]) {
    const at = text.indexOf(rpc);
    assert.ok(at > 0, `${rpc} is no longer called — update this test with the surface`);
    // The params object follows the method name within the same call.
    const window = text.slice(at, at + 500);
    assert.match(
      window,
      /objectGroup:\s*groupName/,
      `${rpc} must pass { objectGroup: groupName } — Flutter throws in-app without it`,
    );
  }
});
