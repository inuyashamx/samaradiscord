import { OpenAIProvider } from './mind/llm.js';
import { openDb } from './mind/db.js';
import { MemoryStore } from './mind/memory.js';
import { Relationships } from './mind/relationships.js';
import { EmotionState } from './mind/emotion.js';
import { Mind } from './mind/mind.js';
import { DiscordBody } from './body/discord.js';

async function main(): Promise<void> {
  const llm = new OpenAIProvider();
  const db = openDb();
  const memory = new MemoryStore(db);
  const relationships = new Relationships(db);
  const emotion = new EmotionState();
  console.log(`🧠 Memoria de largo plazo: ${memory.count()} recuerdos`);
  const mind = new Mind(llm, memory, relationships, emotion, 'discord');
  const body = new DiscordBody(mind);

  await body.start();
}

main().catch((err) => {
  console.error('Fallo al arrancar a Samara:', err);
  process.exit(1);
});
