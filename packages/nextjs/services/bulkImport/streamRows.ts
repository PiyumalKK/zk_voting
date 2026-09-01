/**
 * Streams a bulk-import route's row-by-row results as NDJSON instead of
 * buffering the whole batch into one JSON response.
 *
 * A 1,000-row CSV can take minutes (each row is a sequential on-chain write —
 * see the routes that use this for why). Buffering meant the client had
 * nothing to show but a spinner for that whole time, with no way to tell
 * "processing row 40" from "hung." Streaming one line per completed row lets
 * the client show real progress instead.
 *
 * Line shapes, one JSON object per line:
 *   {"type":"total","total":N}        — sent once, before any rows
 *   {"type":"row","result":{...}}     — sent after each row, in order
 *
 * Deliberately carries no final "succeeded/failed" summary line: every
 * caller already computes that from the same row shape for the results
 * table, so the client derives it once the stream ends rather than trusting
 * two sources that could disagree.
 */
export function streamRowResults<T>(total: number, process: (send: (result: T) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // Client disconnected (navigated away, tab closed) — nothing left to write to.
        }
      };
      send({ type: "total", total });
      try {
        await process(result => send({ type: "row", result }));
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed/errored by a disconnect above.
        }
      }
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
