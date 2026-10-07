import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from "@duckdb/node-api";
import { REMOTE_FILES, ReleaseIntegrityError, type Release } from "./release.js";

/** Release tables the tools may query. Each becomes a view over a verified local file (or a size-checked URL). */
export type TableName =
  | "agg_code_prices"
  | "files"
  | "dim_charge_codes"
  | "fct_standard_charges"
  | "dim_provider_history"
  | "rpt_npi_reconciliation"
  | "rpt_source_conformance"
  | "rpt_npi_resolution";

export type Row = Record<string, DuckDBValue>;

const sqlString = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * DuckDB over one pinned release. Views are created lazily, the first time a tool needs a table, so the server
 * starts instantly and only downloads what a question actually touches. Queries are serialised on one connection.
 */
export class Db {
  private readonly views = new Map<TableName, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly release: Release,
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
  ) {}

  static async open(release: Release): Promise<Db> {
    const instance = await DuckDBInstance.create(":memory:");
    return new Db(release, instance, await instance.connect());
  }

  /** Make sure the views exist (downloading and verifying their files if needed), then run a parameterised query. */
  async query(tables: readonly TableName[], sql: string, params: Record<string, DuckDBValue> = {}): Promise<Row[]> {
    await Promise.all(tables.map((t) => this.ensureView(t)));
    return this.serial(async () => (await this.conn.runAndReadAll(sql, params)).getRowObjects());
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
  }

  private ensureView(table: TableName): Promise<void> {
    let p = this.views.get(table);
    if (!p) {
      p = this.createView(table);
      p.catch(() => this.views.delete(table));
      this.views.set(table, p);
    }
    return p;
  }

  private async createView(table: TableName): Promise<void> {
    const file = `${table}.parquet`;
    let location: string;
    if (REMOTE_FILES.has(file)) {
      const remote = await this.release.remoteFile(file);
      location = remote.location;
      // A range read cannot be hashed; the strongest cheap check is the footer's row count against the manifest.
      const [meta] = await this.serial(async () =>
        (await this.conn.runAndReadAll(`SELECT sum(num_rows) AS n FROM parquet_file_metadata(${sqlString(location)})`)).getRowObjects(),
      );
      const rows = int(meta?.["n"]);
      if (rows !== remote.rows) {
        throw new ReleaseIntegrityError(
          `Refusing to read ${file}: its Parquet footer reports ${rows} rows at ${location}, but release ` +
            `${this.release.pin.tag}'s manifest says ${remote.rows}. The published file has changed since the release was cut.`,
        );
      }
    } else {
      location = await this.release.localFile(file);
    }
    // The location is a cache path or the pinned release URL, never user input.
    await this.serial(() => this.conn.run(`CREATE OR REPLACE VIEW ${table} AS SELECT * FROM read_parquet(${sqlString(location)})`));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

// --- Converting DuckDB values at the boundary, so nothing typed `any` reaches a tool's output ---

export function str(v: DuckDBValue | undefined): string {
  if (v === null || v === undefined) throw new TypeError("expected a string, got NULL");
  return typeof v === "string" ? v : String(v);
}

export function strOrNull(v: DuckDBValue | undefined): string | null {
  return v === null || v === undefined ? null : str(v);
}

export function int(v: DuckDBValue | undefined): number {
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`integer ${v} is outside the safe range`);
    }
    return Number(v);
  }
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new TypeError(`expected an integer, got ${String(v)}`);
}

export function numOrNull(v: DuckDBValue | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return int(v);
  throw new TypeError(`expected a number, got ${String(v)}`);
}
