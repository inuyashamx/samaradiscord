import { openDb, type DB } from './db.js';

const MAX_GOALS = 5;
const MAX_DESIRES = 5;

/**
 * El "yo en movimiento" de Samara: lo que se propone (metas) y lo que va
 * descubriendo que le importa de verdad (deseos personales). Ella misma los
 * gestiona —los anota, los suelta— mediante herramientas, así que evolucionan
 * bajo SU control conforme vive, no por un proceso automático.
 *
 * (Sus deseos de canon, fijos, viven en persona.desires; estos son los que ella
 * desarrolla encima.) Persistente, sobrevive a reinicios.
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

  // --- Metas (lo que se propone ahora) ---
  get(): string[] {
    return this.read('goals');
  }
  set(goals: string[]): void {
    this.write('goals', goals.slice(0, MAX_GOALS));
  }
  /** Ella se propone una meta nueva. */
  add(goal: string): void {
    const g = goal.trim();
    if (!g) return;
    const cur = this.get();
    if (cur.some((x) => similar(x, g))) return; // ya la tiene
    this.set([...cur, g]);
  }
  /** Ella suelta/cumple una meta. */
  remove(goal: string): void {
    const g = goal.trim().toLowerCase();
    this.set(this.get().filter((x) => !similar(x, g)));
  }

  // --- Deseos personales (lo que descubre que le importa) ---
  getDesires(): string[] {
    return this.read('desires_personales');
  }
  addDesire(desire: string): void {
    const d = desire.trim();
    if (!d) return;
    const cur = this.getDesires();
    if (cur.some((x) => similar(x, d))) return;
    this.write('desires_personales', [...cur, d].slice(0, MAX_DESIRES));
  }

  private read(key: string): string[] {
    const row = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as
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

  private write(key: string, value: string[]): void {
    this.db
      .prepare(
        `INSERT INTO state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(key, JSON.stringify(value));
  }
}

/** ¿Dos textos se refieren a lo mismo? (para no duplicar / poder soltar). */
function similar(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}
