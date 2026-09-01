/**
 * Shared input abstraction for bulk imports (GN officers, voter eligibility rolls).
 *
 * Both bulk endpoints accept either a CSV upload or a pull from an external
 * identity-management HTTP API, and process the exact same row shape either
 * way — this is the one seam that makes that true. Adding a third source
 * (e.g. a direct DB connection) later means adding one more `RowSource`
 * implementation, not touching the routes that consume it.
 */

export type ImportRow = Record<string, string | undefined>;

export interface RowSource {
  fetchRows(): Promise<ImportRow[]>;
}

export class RowSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowSourceError";
  }
}

/**
 * Splits one CSV line into fields, honouring double-quoted fields that may
 * contain commas or escaped (`""`) quotes. Not a general CSV library —
 * intentionally small, matching the project's dependency-free style
 * (`services/otp/otpService.ts`) for a format whose shape this project fully
 * controls (a handful of known, simple columns).
 */
const splitCsvLine = (line: string): string[] => {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
};

/**
 * Parses a CSV string (header row + data rows) already sitting in memory —
 * the route reads the uploaded file into a string before constructing this.
 *
 * Header cells become lower-cased, trimmed object keys, so `Name`, `name`
 * and ` NAME ` in the source file all address the same field.
 */
export class CsvRowSource implements RowSource {
  constructor(private readonly csvText: string) {}

  async fetchRows(): Promise<ImportRow[]> {
    const lines = this.csvText.split(/\r\n|\r|\n/).filter(line => line.trim().length > 0);
    if (lines.length === 0) return [];

    const header = splitCsvLine(lines[0]).map(cell => cell.trim().toLowerCase());
    if (header.length === 0 || header.every(cell => cell === "")) {
      throw new RowSourceError("CSV has no header row.");
    }

    return lines.slice(1).map(line => {
      const cells = splitCsvLine(line);
      const row: ImportRow = {};
      header.forEach((key, index) => {
        if (key) row[key] = cells[index]?.trim();
      });
      return row;
    });
  }
}

/**
 * Pulls rows from an external HTTP API — the shape the user's own
 * identity-management server will eventually expose. Expects a bare JSON
 * array of objects in the same shape a CSV would parse into; anything else
 * is refused with a clear error rather than silently importing nothing.
 *
 * The API key (if any) is used for this one request and never persisted —
 * the route that constructs this class does not store credentials anywhere.
 */
export class RemoteApiRowSource implements RowSource {
  constructor(
    private readonly url: string,
    private readonly headers?: Record<string, string>,
  ) {}

  async fetchRows(): Promise<ImportRow[]> {
    let response: Response;
    try {
      response = await fetch(this.url, { headers: this.headers, method: "GET" });
    } catch (error) {
      throw new RowSourceError(
        `Could not reach the identity-management API: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new RowSourceError(`Identity-management API responded with ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RowSourceError("Identity-management API did not return valid JSON.");
    }
    if (!Array.isArray(body)) {
      throw new RowSourceError("Identity-management API must return a JSON array of row objects.");
    }
    return body.map(item => {
      if (typeof item !== "object" || item === null) {
        throw new RowSourceError("Every row from the identity-management API must be an object.");
      }
      const row: ImportRow = {};
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        row[key.trim().toLowerCase()] = value === undefined || value === null ? undefined : String(value);
      }
      return row;
    });
  }
}

/** The request body shape both bulk routes accept. */
export type BulkImportSourceInput = { source: "csv"; csv: string } | { source: "api"; url: string; apiKey?: string };

/** Builds the matching `RowSource` for a request body, or throws `RowSourceError`. */
export const buildRowSource = (input: BulkImportSourceInput): RowSource => {
  if (input.source === "csv") {
    if (typeof input.csv !== "string" || input.csv.trim().length === 0) {
      throw new RowSourceError("`csv` must be a non-empty string.");
    }
    return new CsvRowSource(input.csv);
  }
  if (input.source === "api") {
    if (typeof input.url !== "string" || input.url.trim().length === 0) {
      throw new RowSourceError("`url` must be a non-empty string.");
    }
    const headers = input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : undefined;
    return new RemoteApiRowSource(input.url, headers);
  }
  throw new RowSourceError('`source` must be "csv" or "api".');
};
