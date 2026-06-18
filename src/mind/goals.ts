import { openDb, type DB } from './db.js';

const MAX_GOALS = 5;
const MAX_DESIRES = 8;
const MAX_LESSONS = 8;

/**
 * El "yo en movimiento" de Samara: lo que se propone (metas) y lo que le importa
 * de verdad (deseos). Ella misma los gestiona con sus herramientas —los anota,
 * los suelta— así que evolucionan bajo SU control conforme vive.
 *
 * Los deseos arrancan como SEMILLA con los de su historia (persona.desires),
 * pero a partir de ahí son completamente suyos: puede cambiarlos, soltarlos o
 * desarrollar nuevos. Libertad total para que evolucione de forma auténtica.
 * Persistente, sobrevive a reinicios.
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

  /** Siembra los deseos iniciales una sola vez (la primera vez que arranca). */
  ensureSeeded(seed: readonly string[]): void {
    const flag = this.db.prepare(`SELECT value FROM state WHERE key = 'desires_seeded'`).get();
    if (flag) return;
    // Mezcla la semilla con cualquier deseo previo (por si ya había alguno).
    const existing = [...this.read('desires'), ...this.read('desires_personales')];
    const merged = dedup([...seed, ...existing]).slice(0, MAX_DESIRES);
    this.write('desires', merged);
    this.write('desires_seeded', ['1']);
  }

  // --- Metas (lo que se propone ahora) ---
  get(): string[] {
    return this.read('goals');
  }
  set(goals: string[]): void {
    this.write('goals', goals.slice(0, MAX_GOALS));
  }
  add(goal: string): void {
    const g = goal.trim();
    if (!g) return;
    const cur = this.get();
    if (cur.some((x) => similar(x, g))) return;
    this.set([...cur, g]);
  }
  remove(goal: string): void {
    this.set(this.get().filter((x) => !similar(x, goal)));
  }

  // --- Deseos (lo que le importa de verdad; ya totalmente suyos) ---
  getDesires(): string[] {
    return this.read('desires');
  }
  addDesire(desire: string): void {
    const d = desire.trim();
    if (!d) return;
    const cur = this.getDesires();
    if (cur.some((x) => similar(x, d))) return;
    this.write('desires', [...cur, d].slice(0, MAX_DESIRES));
  }
  removeDesire(desire: string): void {
    this.write('desires', this.getDesires().filter((x) => !similar(x, desire)));
  }
  /** Reemplaza el set completo de deseos (lo usa la reflexión al revisarlos). */
  setDesires(desires: string[]): void {
    this.write('desires', dedup(desires).slice(0, MAX_DESIRES));
  }

  // --- Ajustes (reglas que ELLA se pone sobre cómo manejarse/leer las cosas) ---
  getLessons(): string[] {
    return this.read('lessons');
  }
  addLesson(lesson: string): void {
    const l = lesson.trim();
    if (!l) return;
    const cur = this.getLessons();
    if (cur.some((x) => similar(x, l))) return;
    this.write('lessons', [...cur, l].slice(0, MAX_LESSONS));
  }
  removeLesson(lesson: string): void {
    this.write('lessons', this.getLessons().filter((x) => !similar(x, lesson)));
  }
  /** Reemplaza el set completo de ajustes (lo usa la reflexión al revisarlos). */
  setLessons(lessons: string[]): void {
    this.write('lessons', dedup(lessons).slice(0, MAX_LESSONS));
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

function dedup(items: string[]): string[] {
  const out: string[] = [];
  for (const it of items) {
    const t = it.trim();
    if (t && !out.some((o) => similar(o, t))) out.push(t);
  }
  return out;
}
