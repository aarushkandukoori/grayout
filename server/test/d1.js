// A tiny stand-in for Cloudflare D1, backed by an in-memory SQLite database
// (node:sqlite). It has D1's shape and nothing more:
//   db.prepare(sql).bind(...values).first() / .all() / .run()
//   db.batch([statements])   (one transaction)
//   db.exec(sql)
// It applies server/migrations/*.sql in order, with foreign keys on, so the
// tests run against the real schema.
//
// Every call yields to the event loop first, the way a real D1 call does, so
// two "simultaneous" requests in a test really do interleave between
// statements. Each statement itself is atomic, exactly as in D1.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function checkValues(values) {
  for (const v of values) {
    // D1 refuses undefined; booleans are a bug in our code (we bind 0/1).
    if (v === undefined) throw new Error('D1_TYPE_ERROR: undefined cannot be bound');
    if (typeof v === 'boolean') throw new Error('D1 shim: bind 0/1, not a boolean');
  }
}

class Statement {
  constructor(shim, sql, values = []) {
    this.shim = shim;
    this.sql = sql;
    this.values = values;
  }

  bind(...values) {
    checkValues(values);
    return new Statement(this.shim, this.sql, values);
  }

  // Run synchronously and return plain row objects.
  execute() {
    const rows = this.shim.sqlite.prepare(this.sql).all(...this.values).map(row => ({ ...row }));
    const changes = this.shim.sqlite.prepare('SELECT changes() AS n').get().n;
    return { rows, changes };
  }

  async first(column) {
    await this.shim.tick();
    const { rows } = this.execute();
    if (!rows.length) return null;
    return column ? rows[0][column] : rows[0];
  }

  async all() {
    await this.shim.tick();
    const { rows, changes } = this.execute();
    return { success: true, results: rows, meta: { changes } };
  }

  async run() {
    await this.shim.tick();
    const { rows, changes } = this.execute();
    return { success: true, results: rows, meta: { changes } };
  }
}

export class D1Shim {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.statements = 0;
    for (const file of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()) {
      this.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    }
  }

  async tick() {
    this.statements += 1;
    await new Promise(resolve => setImmediate(resolve));
  }

  prepare(sql) {
    return new Statement(this, sql);
  }

  async batch(statements) {
    await this.tick();
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map(s => {
        const { rows, changes } = s.execute();
        return { success: true, results: rows, meta: { changes } };
      });
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql) {
    await this.tick();
    this.sqlite.exec(sql);
  }

  /** Test-only: read rows directly. */
  rows(sql, ...values) {
    return this.sqlite.prepare(sql).all(...values).map(row => ({ ...row }));
  }

  /** Test-only: write directly (to set up a state). */
  write(sql, ...values) {
    this.sqlite.prepare(sql).run(...values);
  }
}
