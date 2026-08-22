import { test } from "node:test";
import assert from "node:assert/strict";
import { withInspectorGroup, type IsolateCall } from "./inspectorGroup.js";

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
