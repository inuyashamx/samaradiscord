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
  authorId: string;
  authorName: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  createdAt: number;
  distance: number;
}

/** Pistas de contexto para priorizar recuerdos de la persona/canal actual. */
export interface RecallContext {
  authorId?: string;
  channelId?: string;
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

  /**
   * Recupera los k recuerdos más relevantes. No ordena solo por parecido
   * (similitud): puntúa cada candidato combinando RELEVANCIA + RECENCIA +
   * IMPORTANCIA (como en Generative Agents), para que lo útil suba antes que el
   * ruido viejo que solo "suena" parecido.
   */
  recall(embedding: number[], k = 5, ctx: RecallContext = {}): RetrievedMemory[] {
    // 1) Trae un set amplio de candidatos por parecido.
    const candidateLimit = Math.max(k * 4, 30);
    const cand = this.db
      .prepare(
        `SELECT m.id AS id, m.channel_id AS channelId, m.author_id AS authorId,
                m.author_name AS authorName, m.content AS content, m.kind AS kind,
                m.importance AS importance, m.created_at AS createdAt, v.distance AS distance
         FROM (
           SELECT rowid AS id, distance
           FROM vec_memories
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?
         ) v
         JOIN memories m ON m.id = v.id`
      )
      .all(JSON.stringify(embedding), candidateLimit) as RetrievedMemory[];

    if (cand.length <= k) {
      return cand.sort((a, b) => a.distance - b.distance);
    }

    // 2) Re-puntúa: relevancia + recencia + importancia + contexto (que los
    //    recuerdos de la persona y del canal actuales suban, para no cruzar
    //    conversaciones ni juzgar a alguien por lo que dijo otro).
    const now = Date.now();
    const dists = cand.map((c) => c.distance);
    const span = Math.max(...dists) - Math.min(...dists) || 1;

    const scored = cand.map((c) => {
      const relevance = (Math.max(...dists) - c.distance) / span; // 0..1 (1 = más cercano)
      const ageDays = (now - c.createdAt) / 86_400_000;
      const recency = Math.exp(-ageDays / 14); // ~2 semanas de vida media
      const importance = Math.min(c.importance, 10) / 10;
      const sameAuthor = ctx.authorId && c.authorId === ctx.authorId ? 0.4 : 0;
      const sameChannel = ctx.channelId && c.channelId === ctx.channelId ? 0.2 : 0;
      const score = 1.0 * relevance + 0.3 * recency + 0.5 * importance + sameAuthor + sameChannel;
      return { c, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map((s) => s.c);
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

  /** Lo último que dijo una persona concreta (para "qué sé de ti"). */
  recentByAuthor(authorId: string, limit = 6): MemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, channel_id AS channelId, author_id AS authorId,
                author_name AS authorName, content, kind, importance,
                created_at AS createdAt
         FROM memories
         WHERE author_id = ? AND kind = 'episodic'
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(authorId, limit) as MemoryRecord[];
    return rows.reverse();
  }

  /**
   * Olvida los recuerdos episódicos viejos que sobran: conserva los `keep` más
   * recientes y borra el resto (con su vector). Las reflexiones NO se tocan.
   * Devuelve cuántos olvidó.
   */
  forgetOldEpisodic(keep: number): number {
    if (keep <= 0) return 0;
    const ids = this.db
      .prepare(
        `SELECT id FROM memories WHERE kind = 'episodic'
         ORDER BY created_at DESC LIMIT -1 OFFSET ?`
      )
      .all(keep) as Array<{ id: number }>;
    if (ids.length === 0) return 0;

    const delVec = this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
    const delMem = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const tx = this.db.transaction((rows: Array<{ id: number }>) => {
      for (const r of rows) {
        delVec.run(BigInt(r.id));
        delMem.run(r.id);
      }
    });
    tx(ids);
    return ids.length;
  }

  /** Borra todas las reflexiones (para reemplazarlas por una versión revisada). */
  deleteReflections(): void {
    const ids = this.db
      .prepare(`SELECT id FROM memories WHERE kind = 'reflection'`)
      .all() as Array<{ id: number }>;
    if (ids.length === 0) return;
    const delVec = this.db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
    const tx = this.db.transaction((rows: Array<{ id: number }>) => {
      for (const r of rows) delVec.run(BigInt(r.id));
      this.db.prepare(`DELETE FROM memories WHERE kind = 'reflection'`).run();
    });
    tx(ids);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as {
      n: number;
    };
    return row.n;
  }
}
