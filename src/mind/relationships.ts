import { openDb, type DB } from './db.js';

export interface Relationship {
  authorId: string;
  authorName: string;
  /**
   * AFECTO: cuánto le cae bien esa persona, -1 (mal) a 1 (muy bien). Empieza en
   * 0. Se mueve solo con lo que vive (apreciación), y ella puede fijarlo a mano.
   */
  affinity: number;
  /**
   * TOLERANCIA: cuánto le aguanta a esa persona (bromas, tanteos, insistencia),
   * -1 (ninguna: corta al primer empujón) a 1 (mucha: se lo toma con calma).
   * Es independiente del afecto: puedes querer a alguien y aguantarle poco.
   * Este lo maneja ELLA: lo pone según con quién quiere soltarse o marcar raya.
   */
  tolerance: number;
  /** Cuántas veces han interactuado (cuánto la conoce). */
  familiarity: number;
  /** Cuándo fue la última interacción (ms epoch). */
  updatedAt?: number;
}

/** Tramos de afinidad. Una sola fuente de verdad para todos lados. */
export type AffinityBand = 'muy_bien' | 'bien' | 'normal' | 'distante' | 'mal';

/**
 * Convierte la afinidad (-1..1) en un tramo. Gradual a propósito: "buena onda"
 * se gana de verdad (>=0.6), no con un 0.30 apenas positivo. Simétrico en lo
 * negativo. Así el trato cambia poco a poco en vez de saltar de golpe.
 */
export function affinityBand(affinity: number): AffinityBand {
  if (affinity >= 0.6) return 'muy_bien';
  if (affinity >= 0.2) return 'bien';
  if (affinity > -0.2) return 'normal';
  if (affinity > -0.6) return 'distante';
  return 'mal';
}

/** Tramos de tolerancia (cuánto le aguanta a alguien antes de cortar). */
export type ToleranceBand = 'mucha' | 'algo' | 'normal' | 'poca' | 'ninguna';

/** Convierte la tolerancia (-1..1) en un tramo, gradual igual que el afecto. */
export function toleranceBand(tolerance: number): ToleranceBand {
  if (tolerance >= 0.6) return 'mucha';
  if (tolerance >= 0.2) return 'algo';
  if (tolerance > -0.2) return 'normal';
  if (tolerance > -0.6) return 'poca';
  return 'ninguna';
}

/**
 * Lo que Samara siente por cada persona. Persistente: así "recuerda" con quién
 * se lleva bien entre sesiones, y de ahí van saliendo sus amistades.
 */
export class Relationships {
  private db: DB;

  constructor(db: DB = openDb()) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relationships (
        author_id TEXT PRIMARY KEY,
        author_name TEXT NOT NULL,
        affinity REAL NOT NULL DEFAULT 0,
        familiarity INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
    // Migración: la tolerancia llegó después, la agregamos si falta (BD vieja).
    const cols = this.db.prepare(`PRAGMA table_info(relationships)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'tolerance')) {
      this.db.exec(`ALTER TABLE relationships ADD COLUMN tolerance REAL NOT NULL DEFAULT 0`);
    }
  }

  /** Todas las relaciones, de la más conocida a la menos. */
  all(): Relationship[] {
    return this.db
      .prepare(
        `SELECT author_id AS authorId, author_name AS authorName, affinity, tolerance,
                familiarity, updated_at AS updatedAt
         FROM relationships ORDER BY familiarity DESC, affinity DESC`
      )
      .all() as Relationship[];
  }

  get(authorId: string): Relationship | null {
    const row = this.db
      .prepare(
        `SELECT author_id AS authorId, author_name AS authorName, affinity, tolerance,
                familiarity, updated_at AS updatedAt FROM relationships WHERE author_id = ?`
      )
      .get(authorId) as Relationship | undefined;
    return row ?? null;
  }

  /** Busca a alguien por nombre (para que ella pueda ajustar "a michi"). */
  findByName(name: string): Relationship | null {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const rows = this.all();
    return (
      rows.find((r) => r.authorName.toLowerCase() === n) ??
      rows.find((r) => r.authorName.toLowerCase().includes(n) || n.includes(r.authorName.toLowerCase())) ??
      null
    );
  }

  /**
   * Fija a mano el afecto y/o la tolerancia con alguien. Es la vía por la que
   * SAMARA se configura a sí misma con cada persona (no la apreciación).
   */
  setMeters(authorId: string, meters: { afecto?: number; tolerancia?: number }): Relationship | null {
    const cur = this.get(authorId);
    if (!cur) return null;
    const affinity = meters.afecto !== undefined ? clamp(meters.afecto, -1, 1) : cur.affinity;
    const tolerance = meters.tolerancia !== undefined ? clamp(meters.tolerancia, -1, 1) : cur.tolerance;
    this.db
      .prepare(`UPDATE relationships SET affinity = ?, tolerance = ?, updated_at = ? WHERE author_id = ?`)
      .run(affinity, tolerance, Date.now(), authorId);
    return { ...cur, affinity, tolerance };
  }

  /** Registra una interacción y ajusta la afinidad (delta entre -1 y 1). */
  bump(authorId: string, authorName: string, affinityDelta: number): Relationship {
    const current = this.get(authorId);
    const affinity = clamp((current?.affinity ?? 0) + affinityDelta, -1, 1);
    const familiarity = (current?.familiarity ?? 0) + 1;
    // La tolerancia NO la mueve la apreciación: es de ella. Aquí solo se conserva.
    const tolerance = current?.tolerance ?? 0;

    this.db
      .prepare(
        `INSERT INTO relationships (author_id, author_name, affinity, familiarity, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(author_id) DO UPDATE SET
           author_name = excluded.author_name,
           affinity = excluded.affinity,
           familiarity = excluded.familiarity,
           updated_at = excluded.updated_at`
      )
      .run(authorId, authorName, affinity, familiarity, Date.now());

    return { authorId, authorName, affinity, tolerance, familiarity };
  }

  /** Describe la relación en palabras, para meterla en el prompt. */
  describe(rel: Relationship | null): string {
    if (!rel || rel.familiarity === 0) {
      return 'No conoces a esta persona, es la primera vez que hablan.';
    }
    if (rel.familiarity < 5) {
      return `Conoces poco a ${rel.authorName}, apenas se están conociendo.`;
    }
    const n = rel.authorName;
    switch (affinityBand(rel.affinity)) {
      case 'muy_bien':
        return `${n} te cae muy bien, hay buena onda y confianza entre ustedes.`;
      case 'bien':
        return `${n} te agrada, te llevas bien con él, aunque sin tanta confianza todavía.`;
      case 'distante':
        return `${n} no te termina de caer, hay cierta distancia.`;
      case 'mal':
        return `${n} no te cae bien, ha habido roces.`;
      default:
        return `Conoces a ${n}, se tratan con normalidad.`;
    }
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
