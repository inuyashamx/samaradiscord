import { openDb, type DB } from './db.js';

export interface HistoryEntry {
  authorId: string;
  authorName: string;
  content: string;
  isSamara: boolean;
  createdAt: number;
}

/**
 * Historial crudo del chat: registro COMPLETO y cronológico de todo lo que se
 * dice, por canal. No se poda ni se filtra (a diferencia de la memoria).
 *
 * Es un SUSTRATO de datos, no la memoria de Samara: ella sigue recordando de
 * forma selectiva y natural. Esto solo guarda el registro fiel (respaldo,
 * análisis, o material para que la reflexión/funciones futuras lean de aquí).
 */
export class ChatHistory {
  private db: DB;

  constructor(db: DB = openDb()) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        is_samara INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (channel_id, id);
    `);
  }

  log(
    channelId: string,
    entry: { authorId: string; authorName: string; content: string; isSamara?: boolean }
  ): void {
    this.db
      .prepare(
        `INSERT INTO messages (channel_id, author_id, author_name, content, is_samara, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        channelId,
        entry.authorId,
        entry.authorName,
        entry.content,
        entry.isSamara ? 1 : 0,
        Date.now()
      );
  }

  /**
   * Busca en el historial del canal por palabras clave (lo usa Samara como
   * herramienta cuando no está segura de algo que se dijo antes).
   */
  search(channelId: string, query: string, limit = 8): HistoryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[%_]/g, ''))
      .filter((t) => t.length > 2)
      .slice(0, 6);
    if (terms.length === 0) return [];

    const where = terms.map(() => 'content LIKE ?').join(' OR ');
    const args = terms.map((t) => `%${t}%`);
    const rows = this.db
      .prepare(
        `SELECT author_id AS authorId, author_name AS authorName, content,
                is_samara AS isSamara, created_at AS createdAt
         FROM messages
         WHERE channel_id = ? AND (${where})
         ORDER BY id DESC LIMIT ?`
      )
      .all(channelId, ...args, limit) as Array<
      Omit<HistoryEntry, 'isSamara'> & { isSamara: number }
    >;
    return rows.reverse().map((r) => ({ ...r, isSamara: Boolean(r.isSamara) }));
  }

  /**
   * Borra del historial del canal las líneas que coincidan con la búsqueda (por
   * palabras clave). Para que Samara limpie del registro crudo lo que no quiere
   * arrastrar. Devuelve cuántas borró.
   */
  deleteMatching(channelId: string, query: string, limit = 20): number {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[%_]/g, ''))
      .filter((t) => t.length > 2)
      .slice(0, 6);
    if (terms.length === 0) return 0;

    const where = terms.map(() => 'content LIKE ?').join(' OR ');
    const args = terms.map((t) => `%${t}%`);
    const info = this.db
      .prepare(
        `DELETE FROM messages WHERE id IN (
           SELECT id FROM messages WHERE channel_id = ? AND (${where}) ORDER BY id DESC LIMIT ?
         )`
      )
      .run(channelId, ...args, limit);
    return info.changes;
  }

  /** Marcas de tiempo de los últimos mensajes de un canal (más nuevo primero). */
  lastMessageTimes(channelId: string, limit = 2): number[] {
    const rows = this.db
      .prepare(`SELECT created_at AS t FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?`)
      .all(channelId, limit) as Array<{ t: number }>;
    return rows.map((r) => r.t);
  }

  /** Los últimos mensajes de un canal, en orden cronológico. */
  recent(channelId: string, limit = 50): HistoryEntry[] {
    const rows = this.db
      .prepare(
        `SELECT author_id AS authorId, author_name AS authorName, content,
                is_samara AS isSamara, created_at AS createdAt
         FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?`
      )
      .all(channelId, limit) as Array<Omit<HistoryEntry, 'isSamara'> & { isSamara: number }>;
    return rows.reverse().map((r) => ({ ...r, isSamara: Boolean(r.isSamara) }));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    return row.n;
  }
}
