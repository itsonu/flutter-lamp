/**
 * What this server costs the agent using it.
 *
 * Every tool response is input tokens on the agent's next turn, and until this
 * existed the cost was guessed at rather than known. Measured against a live
 * app with ~1,700 events retained: `tools/list` alone is 16.7kB before any work
 * happens, `diagnose_runtime` is 8.2kB, `get_frames` is 19.8kB for its default
 * 50 frames, and `export_session` is 36kB in `brief` mode against 247kB in
 * `full` — roughly 62,000 tokens, a third of a 200k context window in a single
 * call.
 *
 * One property worth knowing: a tool cannot report its own cost. The response
 * is measured after the handler returns, so `runtime_status` shows what the
 * calls *before* it spent, never including itself.
 *
 * Bytes are counted, not tokens. Tokens depend on the tokenizer and cannot be
 * known here, so `estimatedTokens` divides by four and is labelled an estimate
 * wherever it surfaces. Reporting a real measurement next to an honest estimate
 * beats reporting a confident number that is wrong.
 */

export interface ToolCost {
  calls: number;
  bytes: number;
  errors: number;
  /** Slowest single call, ms. Cheap to keep and it is what a human asks next. */
  slowestMs: number;
}

export interface CostReport {
  calls: number;
  responseBytes: number;
  /** bytes / 4. An estimate, not a measurement — see the note above. */
  estimatedTokens: number;
  errors: number;
  /** Per tool, largest total first. */
  byTool: Array<{ tool: string } & ToolCost>;
}

class CostMeter {
  private tools = new Map<string, ToolCost>();

  record(tool: string, bytes: number, ms: number, isError: boolean): void {
    const t = this.tools.get(tool) ?? { calls: 0, bytes: 0, errors: 0, slowestMs: 0 };
    t.calls += 1;
    t.bytes += bytes;
    if (isError) t.errors += 1;
    if (ms > t.slowestMs) t.slowestMs = ms;
    this.tools.set(tool, t);
  }

  /** Called on connect: cost is per debugging session, like every other count. */
  reset(): void {
    this.tools.clear();
  }

  report(): CostReport {
    const byTool = [...this.tools.entries()]
      .map(([tool, t]) => ({ tool, ...t }))
      .sort((a, b) => b.bytes - a.bytes);
    const responseBytes = byTool.reduce((sum, t) => sum + t.bytes, 0);
    return {
      calls: byTool.reduce((sum, t) => sum + t.calls, 0),
      responseBytes,
      estimatedTokens: Math.round(responseBytes / 4),
      errors: byTool.reduce((sum, t) => sum + t.errors, 0),
      byTool,
    };
  }
}

export const costMeter = new CostMeter();
