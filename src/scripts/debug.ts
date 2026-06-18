import { readFileSync } from 'node:fs';

/**
 * Muestra las últimas acciones internas de Samara (data/debug.jsonl) de forma
 * legible. Requiere DEBUG_LOG=true en el .env mientras corre el bot.
 *
 *   npm run debug         (últimas 40)
 *   npm run debug -- 100  (últimas 100)
 */
const FILE = 'data/debug.jsonl';
const N = Number(process.argv[2]) || 40;

const ICON: Record<string, string> = {
  mensaje: '💬',
  recall: '🧠',
  tool: '🔧',
  responde: '🗣️',
  silencio: '🤐',
  apreciacion: '❤️',
  reflexion: '💭',
  olvido: '🗑️',
  proactivo: '✨',
};

let lines: string[] = [];
try {
  lines = readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
} catch {
  console.log('No hay log todavía. Activa DEBUG_LOG=true en .env y deja correr el bot.');
  process.exit(0);
}

for (const line of lines.slice(-N)) {
  try {
    const { t, event, ...data } = JSON.parse(line) as { t: string; event: string };
    const hora = t.slice(11, 19);
    const icon = ICON[event] ?? '·';
    console.log(`${hora} ${icon} ${event}`);
    for (const [k, v] of Object.entries(data)) {
      const val = Array.isArray(v) ? `\n     - ${v.join('\n     - ')}` : JSON.stringify(v);
      console.log(`     ${k}: ${val}`);
    }
  } catch {
    // línea corrupta, ignora
  }
}
