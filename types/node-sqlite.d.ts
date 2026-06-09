// Minimal ambient types for Node's built-in SQLite (node:sqlite).
// Self-contained so we don't need to pin a newer @types/node. Covers only the
// surface FirstMerge uses. Full types ship with @types/node >= 22.5 if you'd
// rather upgrade later.
declare module "node:sqlite" {
  interface StatementSync {
    run(params?: unknown): { changes: number; lastInsertRowid: number | bigint };
    get(params?: unknown): unknown;
    all(params?: unknown): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
