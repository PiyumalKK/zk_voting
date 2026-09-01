/**
 * Reads the NDJSON stream `services/bulkImport/streamRows.ts` produces,
 * calling back as each row arrives so the caller can show live progress
 * instead of a spinner with no indication of how far along a multi-minute
 * bulk import actually is.
 */
export async function readNdjsonRows<T>(
  response: Response,
  onTotal: (total: number) => void,
  onRow: (result: T) => void,
): Promise<void> {
  if (!response.body) throw new Error("Response had no body to stream.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as { type: "total"; total: number } | { type: "row"; result: T };
    if (message.type === "total") onTotal(message.total);
    else onRow(message.result);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // last element may be a partial line — keep it for the next chunk
    for (const line of lines) handleLine(line);
  }
  if (buffer.trim()) handleLine(buffer);
}
