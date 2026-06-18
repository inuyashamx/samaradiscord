import { openDb, type DB } from './db.js';

/**
 * Las metas/intenciones actuales de Samara: lo que quiere lograr ahora mismo
 * (p.ej. "que dejen de probarme y me tomen en serio", "averiguar más de X").
 *
 * A diferencia de los deseos (fijos, en la persona), las metas son dinámicas:
 * Samara las forma y las actualiza al reflexionar, según lo que vive. Se guardan
 * persistentes para que sus intenciones sobrevivan a reinicios.
 */
export class Goals {
  private db: DB;

  constructor(db: DB = openDb()) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  get(): string[] {
    const row = this.db.prepare(`SELECT value FROM state WHERE key = 'goals'`).get() as
      | { value: string }
      | undefined;
    if (!row) return [];
    try {
      const arr = JSON.parse(row.value);
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  set(goals: string[]): void {
    const value = JSON.stringify(goals.slice(0, 3));
    this.db
      .prepare(
        `INSERT INTO state (key, value) VALUES ('goals', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(value);
  }
}
