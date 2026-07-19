/**
 * Extract a usable error report from a `Flutter.Error` service event.
 *
 * The event's `extensionData` is a serialized Flutter `DiagnosticsNode` tree
 * (from `FlutterErrorDetails.toJson()`), NOT a flat object — the exception text
 * lives in an `ErrorSummary` property and the stack trace is a run of child
 * nodes whose `description` is a standard Dart frame line (`#0  Foo (pkg:…)`).
 * We walk the whole tree and reconstruct both. This is the only reliable way to
 * get a stack trace out of a realtime Flutter framework error.
 */

export interface ExtractedError {
  /** One-line human summary (the ErrorSummary when present). */
  summary: string;
  /** e.g. "FlutterErrorDetails". */
  type?: string;
  /** e.g. "widgets library". */
  library?: string;
  /** The offending widget, when Flutter reports "error-causing widget". */
  widget?: string;
  /** Reconstructed stack trace (newline-joined frames), or "" if none. */
  stack: string;
}

const FRAME = /^#\d+\s/;
const WIDGET_HEADER = /error-causing widget/i;

export function extractFlutterError(data: any): ExtractedError {
  const frames: string[] = [];
  const errorSummaries: string[] = [];
  const otherText: string[] = [];
  let widget: string | undefined;
  let expectWidgetNext = false;

  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;
    const desc =
      typeof node.description === "string" ? node.description.trim() : "";
    if (desc) {
      if (FRAME.test(desc) || desc === "<asynchronous suspension>") {
        frames.push(desc);
      } else if (expectWidgetNext && !widget) {
        widget = desc;
        expectWidgetNext = false;
      } else if (WIDGET_HEADER.test(desc)) {
        expectWidgetNext = true;
      } else if (node.level === "summary" || node.type === "ErrorSummary") {
        errorSummaries.push(desc);
      } else {
        otherText.push(desc);
      }
    }
    for (const p of node.properties ?? []) visit(p);
    for (const c of node.children ?? []) visit(c);
  };
  visit(data);

  let summary = errorSummaries[0];
  if (!summary && typeof data?.description === "string" && data.description.trim()) {
    summary = data.description.trim();
  }
  if (!summary) summary = otherText[0];
  if (!summary && typeof data?.exceptionAsString === "string") {
    summary = data.exceptionAsString;
  }
  if (!summary) summary = "Flutter framework error";

  return {
    summary: firstLine(summary),
    type: typeof data?.type === "string" ? data.type : undefined,
    library: typeof data?.library === "string" ? data.library : undefined,
    widget,
    stack: frames.join("\n"),
  };
}

export function firstLine(s: string): string {
  const line = s.split("\n")[0].trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}
