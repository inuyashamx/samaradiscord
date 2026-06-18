import { openDb } from '../mind/db.js';
import { MemoryStore } from '../mind/memory.js';
import { Relationships } from '../mind/relationships.js';
import { EmotionState } from '../mind/emotion.js';
import { ChatHistory } from '../mind/history.js';
import { Goals } from '../mind/goals.js';
import { persona } from '../mind/persona.js';

/**
 * Muestra el estado interno de Samara: ánimo, relaciones, opiniones y recuerdos.
 * Solo lee la base de datos (data/samara.db). No necesita claves.
 *
 *   npm run estado
 */
function bar(value: number, min: number, max: number, width = 12): string {
  const pos = Math.round(((value - min) / (max - min)) * width);
  return '█'.repeat(Math.max(0, pos)) + '░'.repeat(Math.max(0, width - pos));
}

function affinityLabel(a: number): string {
  if (a > 0.3) return 'buena onda';
  if (a < -0.3) return 'roces';
  return 'normal';
}

function main(): void {
  const db = openDb();
  const memory = new MemoryStore(db);
  const relationships = new Relationships(db);
  const emotion = new EmotionState(db);
  const history = new ChatHistory(db);
  const goals = new Goals(db);

  console.log('\n═══════════════  ESTADO DE SAMARA  ═══════════════\n');

  // Ánimo
  const mood = emotion.current();
  console.log('🌤️  ÁNIMO AHORA');
  console.log(`   ${emotion.describe()}`);
  console.log(`   valencia  ${bar(mood.valence, -1, 1)}  ${mood.valence.toFixed(2)}`);
  console.log(`   energía   ${bar(mood.arousal, 0, 1)}  ${mood.arousal.toFixed(2)}\n`);

  // Relaciones
  const people = relationships.all();
  console.log(`👥  RELACIONES (${people.length})`);
  if (people.length === 0) {
    console.log('   (todavía no conoce a nadie)\n');
  } else {
    for (const p of people) {
      const fam = `${p.familiarity} interacc.`.padEnd(14);
      const af = `afinidad ${p.affinity.toFixed(2)} (${affinityLabel(p.affinity)})`;
      console.log(`   ${p.authorName.padEnd(16)} ${fam} ${af}`);
    }
    console.log('');
  }

  // Deseos (fijos) y metas (dinámicas)
  goals.ensureSeeded(persona.desires); // por si se consulta antes de arrancar el bot
  console.log('🎯  LO QUE LA MUEVE');
  const deseos = goals.getDesires();
  console.log(`   deseos (suyos, los evoluciona ella) (${deseos.length}):`);
  for (const d of deseos) console.log(`     · ${d}`);
  const metas = goals.get();
  console.log(`   metas que se ha propuesto (${metas.length}):`);
  if (metas.length === 0) console.log('     (aún no se ha propuesto nada concreto)');
  else for (const g of metas) console.log(`     › ${g}`);
  const lessons = goals.getLessons();
  if (lessons.length > 0) {
    console.log(`   ajustes que se ha puesto (${lessons.length}):`);
    for (const l of lessons) console.log(`     ~ ${l}`);
  }
  console.log('');

  // Experiencias (vivencias que guardó)
  const experiences = memory.recentMemories(12, 'experience');
  if (experiences.length > 0) {
    console.log(`🎬  EXPERIENCIAS QUE HA VIVIDO (${experiences.length})`);
    for (const e of experiences) console.log(`   • ${e.content}`);
    console.log('');
  }

  // Opiniones propias (reflexiones)
  const reflections = memory.recentMemories(15, 'reflection');
  console.log(`💭  OPINIONES / CONCLUSIONES (${reflections.length})`);
  if (reflections.length === 0) {
    console.log('   (aún no ha reflexionado lo suficiente)\n');
  } else {
    for (const r of reflections) console.log(`   • ${r.content}`);
    console.log('');
  }

  // Recuerdos recientes
  const recents = memory.recentMemories(12, 'episodic');
  console.log(`🧠  RECUERDOS RECIENTES (de ${memory.count()} en total)`);
  if (recents.length === 0) {
    console.log('   (sin recuerdos todavía)\n');
  } else {
    for (const m of recents) {
      const snippet = m.content.length > 70 ? m.content.slice(0, 67) + '...' : m.content;
      console.log(`   ${m.authorName}: ${snippet}`);
    }
    console.log('');
  }

  console.log(`📜  Historial crudo: ${history.count()} mensajes registrados`);
  console.log('\n══════════════════════════════════════════════════\n');
}

main();
