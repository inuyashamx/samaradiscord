import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { OpenAIProvider } from '../mind/llm.js';
import { openDb } from '../mind/db.js';
import { MemoryStore } from '../mind/memory.js';
import { Relationships } from '../mind/relationships.js';
import { EmotionState } from '../mind/emotion.js';
import { ShortTermMemory } from '../mind/short-term-memory.js';
import { ChatHistory } from '../mind/history.js';
import { Goals } from '../mind/goals.js';
import { Mind } from '../mind/mind.js';

/**
 * Chat local con Samara en la terminal — sin Discord.
 * Solo necesita OPENAI_API_KEY en tu .env. Sirve para probar rápido la persona
 * y la memoria. Usa la MISMA mente que el bot, así que lo que pruebes aquí es
 * lo que verás en Discord.
 *
 *   npm run chat            (usa tu nombre por defecto "Tú")
 */
async function main(): Promise<void> {
  const llm = new OpenAIProvider();
  const db = openDb();
  const memory = new MemoryStore(db);
  const relationships = new Relationships(db);
  const emotion = new EmotionState(db);
  const stm = new ShortTermMemory(db);
  const history = new ChatHistory(db);
  const goals = new Goals(db);
  const mind = new Mind(llm, memory, relationships, emotion, stm, history, goals, 'discord');

  const channelId = 'terminal'; // canal ficticio para el chat local
  const authorName = process.env.USER || process.env.USERNAME || 'Tú';

  console.log(`\n🧠 Samara lista. Recuerdos en memoria: ${memory.count()}`);
  console.log('Escribe y pulsa Enter. (Ctrl+C para salir)\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });

  while (true) {
    const text = (await rl.question(`${authorName}: `)).trim();
    if (!text) continue;
    if (text === '/salir' || text === '/exit') break;

    // Comando de prueba: que Samara reflexione ahora y muestre sus conclusiones.
    if (text === '/reflexionar') {
      const ideas = await mind.reflect();
      console.log(ideas.length ? `💭 ${ideas.map((i) => `\n- ${i}`).join('')}\n` : '💭 (aún no hay material suficiente)\n');
      continue;
    }

    history.log(channelId, { authorId: 'local-user', authorName, content: text });
    const reply = await mind.respondTo({
      channelId,
      authorId: 'local-user',
      authorName,
      content: text,
    });
    history.log(channelId, { authorId: 'samara', authorName: 'Samara', content: reply, isSamara: true });
    console.log(`Samara: ${reply}\n`);
  }

  rl.close();
}

main().catch((err) => {
  console.error('Error en el chat:', err);
  process.exit(1);
});
