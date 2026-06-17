import { config } from '../config.js';

export interface Turn {
  authorId: string;
  authorName: string;
  content: string;
  isSamara: boolean;
}

/**
 * Memoria de trabajo: los últimos N turnos por canal, en crudo.
 * Esto es lo que "tiene en mente" Samara ahora mismo.
 *
 * Fase 0: vive solo en RAM (se pierde al reiniciar). En Fase 1 se respalda
 * en SQLite junto con la memoria de largo plazo (episódica + embeddings).
 */
export class ShortTermMemory {
  private buffers = new Map<string, Turn[]>();
  private readonly window = config.behavior.shortTermWindow;

  add(channelId: string, turn: Turn): void {
    const buf = this.buffers.get(channelId) ?? [];
    buf.push(turn);
    if (buf.length > this.window) buf.shift();
    this.buffers.set(channelId, buf);
  }

  recent(channelId: string): Turn[] {
    return this.buffers.get(channelId) ?? [];
  }
}
