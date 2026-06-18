import { appendFileSync, mkdirSync } from 'node:fs';
import { config } from '../config.js';

const FILE = 'data/debug.jsonl';
let dirReady = false;

/**
 * Log de depuración: registra acciones internas (percepción, recall, tools,
 * apreciación, reflexión, respuesta) en data/debug.jsonl, una línea JSON por
 * evento. Se activa con DEBUG_LOG=true. Sirve para auditar que todo gira bien.
 */
export function debugLog(event: string, data: Record<string, unknown> = {}): void {
  if (!config.debug) return;
  try {
    if (!dirReady) {
      mkdirSync('data', { recursive: true });
      dirReady = true;
    }
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
    appendFileSync(FILE, line + '\n');
  } catch {
    // el debug nunca debe romper el flujo
  }
}
