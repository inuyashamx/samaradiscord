import { openDb, type DB } from './db.js';

export interface Reminder {
  id: number;
  channelId: string;
  text: string;
  /** Cuándo sacarlo (ms epoch). */
  fireAt: number;
  createdAt: number;
}

/**
 * Recordatorios de Samara: cosas que ella misma se apunta para sacar MÁS TARDE
 * en el chat ("recuérdame preguntarle a X mañana"). Persistente: sobrevive a
 * reinicios, así que aunque la apaguemos, cuando llegue la hora lo retoma.
 */
export class Reminders {
  private db: DB;

  constructor(db: DB = openDb()) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        text TEXT NOT NULL,
        fire_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /** Apunta un recordatorio. Devuelve su id. */
  add(channelId: string, text: string, fireAt: number): number {
    const info = this.db
      .prepare(`INSERT INTO reminders (channel_id, text, fire_at, created_at) VALUES (?, ?, ?, ?)`)
      .run(channelId, text, fireAt, Date.now());
    return Number(info.lastInsertRowid);
  }

  /** Recordatorios pendientes que ya tocan (fireAt <= ahora). */
  due(now = Date.now()): Reminder[] {
    return this.db
      .prepare(
        `SELECT id, channel_id AS channelId, text, fire_at AS fireAt, created_at AS createdAt
         FROM reminders WHERE done = 0 AND fire_at <= ? ORDER BY fire_at`
      )
      .all(now) as Reminder[];
  }

  /** Marca uno como ya sacado (para no repetirlo). */
  markDone(id: number): void {
    this.db.prepare(`UPDATE reminders SET done = 1 WHERE id = ?`).run(id);
  }

  /** Cuántos pendientes hay (para el estado). */
  countPending(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM reminders WHERE done = 0`).get() as { n: number };
    return row.n;
  }
}
