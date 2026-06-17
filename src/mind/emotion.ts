import { openDb, type DB } from './db.js';

/** Ánimo de Samara en dos ejes simples. */
export interface Mood {
  /** Qué tan bien/mal se siente, -1 (mal) a 1 (bien). */
  valence: number;
  /** Qué tan activada/energética está, 0 (apática) a 1 (excitada). */
  arousal: number;
}

/** Minutos para que el ánimo vuelva ~a la mitad hacia su base (vida media). */
const HALF_LIFE_MIN = 20;

/**
 * Ánimo del día + de la hora: el punto de equilibrio hacia el que decae el
 * ánimo NO es plano. Cada día Samara "amanece" un poco distinta (valencia
 * pseudo-aleatoria estable por fecha), y su energía sube por la tarde y baja de
 * madrugada. Así tiene un fondo propio aunque nadie le hable (Fase 4).
 */
function dailyBaseline(now = new Date()): Mood {
  // Valencia del día: estable durante el día, cambia cada fecha. Rango ~[-0.18, 0.18].
  const daySeed = now.getFullYear() * 1000 + (now.getMonth() + 1) * 50 + now.getDate();
  const valence = (Math.abs(Math.sin(daySeed * 12.9898)) - 0.5) * 0.36;
  // Energía por hora: pico ~6pm, valle ~6am.
  const hour = now.getHours() + now.getMinutes() / 60;
  const arousal = 0.35 + 0.15 * Math.cos(((hour - 18) / 24) * 2 * Math.PI);
  return { valence, arousal: clamp(arousal, 0.15, 0.6) };
}

/**
 * El estado de ánimo de Samara. Es global (ella es una sola persona) y se
 * desvanece con el tiempo hacia el "ánimo del día/hora", como una persona real.
 *
 * Respaldado en SQLite: al reiniciar, retoma el ánimo que tenía (ya con el
 * decaimiento correspondiente al tiempo que estuvo apagada).
 */
export class EmotionState {
  private valence = 0;
  private arousal = 0.35;
  private lastUpdate = Date.now();
  private db: DB;

  constructor(db: DB = openDb()) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.load();
  }

  /** Aplica el decaimiento temporal hacia el ánimo del día/hora. */
  private decay(): void {
    const minutes = (Date.now() - this.lastUpdate) / 60000;
    if (minutes <= 0) return;
    const base = dailyBaseline();
    const k = Math.pow(0.5, minutes / HALF_LIFE_MIN);
    this.valence = base.valence + (this.valence - base.valence) * k;
    this.arousal = base.arousal + (this.arousal - base.arousal) * k;
    this.lastUpdate = Date.now();
  }

  /** Empuja el ánimo según un evento (deltas pequeños, p.ej. ±0.4). */
  nudge(dValence: number, dArousal: number): void {
    this.decay();
    this.valence = clamp(this.valence + dValence, -1, 1);
    this.arousal = clamp(this.arousal + dArousal, 0, 1);
    this.save();
  }

  current(): Mood {
    this.decay();
    return { valence: this.valence, arousal: this.arousal };
  }

  /** Describe el ánimo en palabras, para meterlo en el prompt. */
  describe(): string {
    const { valence, arousal } = this.current();
    const tono =
      valence > 0.35 ? 'de buen humor, animada' : valence < -0.35 ? 'algo molesta o desanimada' : 'tranquila, neutral';
    const energia = arousal > 0.6 ? 'con mucha energía' : arousal < 0.25 ? 'con poca energía, apagada' : 'con energía normal';
    return `${tono}, ${energia}`;
  }

  private load(): void {
    const row = this.db.prepare(`SELECT value FROM state WHERE key = 'emotion'`).get() as
      | { value: string }
      | undefined;
    if (!row) return;
    try {
      const s = JSON.parse(row.value) as Partial<Mood> & { lastUpdate?: number };
      if (typeof s.valence === 'number') this.valence = s.valence;
      if (typeof s.arousal === 'number') this.arousal = s.arousal;
      if (typeof s.lastUpdate === 'number') this.lastUpdate = s.lastUpdate;
    } catch {
      // estado corrupto: arranca desde la base
    }
  }

  private save(): void {
    const value = JSON.stringify({
      valence: this.valence,
      arousal: this.arousal,
      lastUpdate: this.lastUpdate,
    });
    this.db
      .prepare(
        `INSERT INTO state (key, value) VALUES ('emotion', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(value);
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
