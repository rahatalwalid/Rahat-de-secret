// Minimal D1-compatible shim over node:sqlite, for local testing only.
import { DatabaseSync } from "node:sqlite";
export function makeD1(preSql) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  if (preSql) db.exec(preSql);
  class Stmt {
    constructor(sql, params = []) { this.sql = sql; this.params = params; }
    bind(...p) { return new Stmt(this.sql, p); }
    async first(col) { const r = db.prepare(this.sql).get(...this.params); if (!r) return null; return col ? r[col] : { ...r }; }
    async all() { return { results: db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })), success: true, meta: {} }; }
    async run() { const r = db.prepare(this.sql).run(...this.params); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  }
  return {
    prepare: (s) => new Stmt(s),
    async batch(stmts) { db.exec("BEGIN"); try { const out = []; for (const s of stmts) out.push(await s.all()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    raw: db,
  };
}
