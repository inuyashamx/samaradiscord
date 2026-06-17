/** Ánimo de Samara en dos ejes simples. */
export interface Mood {
  /** Qué tan bien/mal se siente, -1 (mal) a 1 (bien). */
  valence: number;
  /** Qué tan activada/energética está, 0 (apática) a 1 (excitada). */
  arousal: number;
}

const BASELINE_VALENCE = 0;
const BASELINE_AROUSAL = 0.35;
/** Minutos para que el ánimo vuelva ~a la mitad hacia su base (vida media). */
const HALF_LIFE_MIN = 20;

/**
 * El estado de ánimo de Samara. Es global (ella es una sola persona) y se
 * desvanece hacia un punto neutral con el tiempo, como en una persona real.
 *
 * Fase 2: vive en memoria (se reinicia al apagar). El ánimo es efímero por
 * naturaleza, así que está bien; lo que persiste son las relaciones.
 */
export class EmotionState {
  private valence = BASELINE_VALENCE;
  private arousal = BASELINE_AROUSAL;
  private lastUpdate = Date.now();

  /** Aplica el decaimiento temporal hacia la base. */
  private decay(): void {
    const minutes = (Date.now() - this.lastUpdate) / 60000;
    if (minutes <= 0) return;
    const k = Math.pow(0.5, minutes / HALF_LIFE_MIN);
    this.valence = BASELINE_VALENCE + (this.valence - BASELINE_VALENCE) * k;
    this.arousal = BASELINE_AROUSAL + (this.arousal - BASELINE_AROUSAL) * k;
    this.lastUpdate = Date.now();
  }

  /** Empuja el ánimo según un evento (deltas pequeños, p.ej. ±0.4). */
  nudge(dValence: number, dArousal: number): void {
    this.decay();
    this.valence = clamp(this.valence + dValence, -1, 1);
    this.arousal = clamp(this.arousal + dArousal, 0, 1);
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
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
