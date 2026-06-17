import { config } from '../config.js';
import { openDb, type DB } from './db.js';

export interface Turn {
  authorId: string;
  authorName: string;
  content: string;
  isSamara: boolean;
}

/**
 * Memoria de trabajo: los últimos N turnos por canal.
 * Esto es lo que "tiene en mente" Samara ahora mismo.
 *
 * Respaldada en SQLite, así que sobrevive a reinicios: al volver, Samara retoma
 * el hilo exacto de la última conversación en vez de despertar en blanco.
 */
export class ShortTermMemory {
  private db: DB;
  private readonly window = config.behavior.shortTermWindow;

  constructor(db: DB = openDb()) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS short_term (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_samara INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_short_term_channel
        ON short_term (channel_id, id);
    `);
  }

  add(channelId: string, turn: Turn): void {
    this.db
      .prepare(
        `INSERT INTO short_term (channel_id, author_id, author_name, content, is_samara, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(channelId, turn.authorId, turn.authorName, turn.content, turn.isSamara ? 1 : 0, Date.now());

    // Mantiene solo los últimos N turnos de ese canal.
    this.db
      .prepare(
        `DELETE FROM short_term
         WHERE channel_id = ?
           AND id NOT IN (
             SELECT id FROM short_term WHERE channel_id = ? ORDER BY id DESC LIMIT ?
           )`
      )
      .run(channelId, channelId, this.window);
  }

  recent(channelId: string): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT author_id AS authorId, author_name AS authorName, content, is_samara AS isSamara
         FROM short_term WHERE channel_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(channelId, this.window) as Array<{
      authorId: string;
      authorName: string;
      content: string;
      isSamara: number;
    }>;

    return rows
      .reverse() // del más viejo al más nuevo
      .map((r) => ({
        authorId: r.authorId,
        authorName: r.authorName,
        content: r.content,
        isSamara: Boolean(r.isSamara),
      }));
  }
}
