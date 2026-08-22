/**
 * Scoped Flutter Inspector object groups.
 *
 * Inspector RPCs take a `groupName`, and every node they return is retained by
 * the *debugged app* until that group is disposed. Reusing one constant group
 * name means every `get_widget_tree` call pins another widget tree in the app's
 * heap forever — a leak caused by the tool that is meant to diagnose memory.
 *
 * Each call gets its own group, disposed when the call finishes.
 */

export type IsolateCall = (method: string, params?: Record<string, unknown>) => Promise<any>;

let sequence = 0;

export async function withInspectorGroup<T>(
  call: IsolateCall,
  fn: (groupName: string) => Promise<T>,
): Promise<T> {
  const groupName = `flutter-lamp-${++sequence}`;
  try {
    return await fn(groupName);
  } finally {
    // Best-effort. A failed dispose must not turn a successful read into an
    // error, and the app releases everything on restart regardless.
    await call("ext.flutter.inspector.disposeGroup", { objectGroup: groupName }).catch(() => {});
  }
}
