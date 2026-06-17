import { openDb, type DB } from './db.js';

/**
 * Dimensión de los embeddings. text-embedding-3-small = 1536.
 * Si cambias el modelo de embeddings, borra data/samara.db (cambia la dimensión).
 */
const EMBED_DIM = 1536;

export type MemoryKind = 'episodic' | 'reflection';

export interface MemoryInput {
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  kind?: MemoryKind;
  importance?: number;
  createdAt?: number;
}

export interface MemoryRecord {
  id: number;
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  createdAt: number;
}

export interface RetrievedMemory {
  id: number;
  channelId: string;
  authorName: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  createdAt: number;
  distance: number;
}

/**
 * Memoria de largo plazo (episódica) de Samara.
 *
 * Cada recuerdo se guarda con su embedding en una tabla vectorial (sqlite-vec).
 * Al responder, Samara recupera por similitud semántica los recuerdos más
 * relevantes al tema actual y los mete en su prompt — así "recuerda" cosas de
 * hace días, no solo los últimos mensajes.
 *
 * Es síncrono (better-sqlite3); la única parte async es generar embeddings,
 * que pasa fuera de aquí (en la Mente, vía LLMProvider).
 */
export class MemoryStore {
  private db: DB;

  constructor(db: DB = openDb()) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        content TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'episodic',
        importance REAL NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories
        USING vec0(embedding float[${EMBED_DIM}]);
    `);
  }

  /** Guarda un recuerdo junto con su embedding. Devuelve el id. */
  remember(mem: MemoryInput, embedding: number[]): number {
    const createdAt = mem.createdAt ?? Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO memories (channel_id, author_id, author_name, content, kind, importance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        mem.channelId,
        mem.authorId,
        mem.authorName,
        mem.content,
        mem.kind ?? 'episodic',
        mem.importance ?? 1,
        createdAt
      );

    const id = info.lastInsertRowid; // bigint
    this.db
      .prepare('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)')
      .run(BigInt(id), JSON.stringify(embedding));

    return Number(id);
  }

  /** Recupera los k recuerdos más cercanos semánticamente al embedding dado. */
  recall(embedding: number[], k = 5): RetrievedMemory[] {
    const rows = this.db
      .prepare(
        `SELECT m.id AS id, m.channel_id AS channelId, m.author_name AS authorName,
                m.content AS content, m.kind AS kind, m.importance AS importance,
                m.created_at AS createdAt, v.distance AS distance
         FROM (
           SELECT rowid AS id, distance
           FROM vec_memories
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?
         ) v
         JOIN memories m ON m.id = v.id
         ORDER BY v.distance`
      )
      .all(JSON.stringify(embedding), k) as RetrievedMemory[];
    return rows;
  }

  /** Recupera los recuerdos más recientes (orden cronológico), opcionalmente por tipo. */
  recentMemories(limit = 30, kind?: MemoryKind): MemoryRecord[] {
    const base = `SELECT id, channel_id AS channelId, author_id AS authorId,
                         author_name AS authorName, content, kind, importance,
                         created_at AS createdAt
                  FROM memories`;
    const rows = (
      kind
        ? this.db.prepare(`${base} WHERE kind = ? ORDER BY created_at DESC LIMIT ?`).all(kind, limit)
        : this.db.prepare(`${base} ORDER BY created_at DESC LIMIT ?`).all(limit)
    ) as MemoryRecord[];
    return rows.reverse(); // del más viejo al más nuevo
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as {
      n: number;
    };
    return row.n;
  }
}
