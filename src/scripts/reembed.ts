import { createLLM } from '../mind/provider.js';
import { openDb } from '../mind/db.js';

/**
 * Re-embebe TODOS los recuerdos con el proveedor activo (LLM_PROVIDER). Úsalo al
 * cambiar de proveedor de embeddings (p.ej. OpenAI -> Gemini): los vectores viejos
 * viven en otro "espacio" y no son comparables con los nuevos, así que la
 * recuperación de memoria se degrada hasta re-embeber todo aquí.
 *
 *   npm run reembed
 *
 * Es idempotente y resistente: si algo falla (p.ej. límite de cuota), lo salta y
 * sigue; puedes volver a correrlo. Los vectores se reemplazan por su rowid, así
 * que no se pierde ningún recuerdo.
 */
async function main(): Promise<void> {
  const llm = createLLM();
  const db = openDb();
  const rows = db.prepare('SELECT id, content FROM memories ORDER BY id').all() as Array<{
    id: number;
    content: string;
  }>;
  console.log(`Re-embebiendo ${rows.length} recuerdos...`);

  const delVec = db.prepare('DELETE FROM vec_memories WHERE rowid = ?');
  const insVec = db.prepare('INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)');
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  let done = 0;
  let failed = 0;
  for (const r of rows) {
    let ok = false;
    for (let intento = 1; intento <= 3 && !ok; intento++) {
      try {
        const emb = await llm.embed(r.content);
        const tx = db.transaction(() => {
          delVec.run(BigInt(r.id));
          insVec.run(BigInt(r.id), JSON.stringify(emb));
        });
        tx();
        ok = true;
      } catch (e) {
        if (intento === 3) {
          failed++;
          console.error(`  fallo id ${r.id}: ${(e as Error).message.slice(0, 80)}`);
        } else {
          await sleep(1500 * intento); // backoff por si es límite de cuota
        }
      }
    }
    if (ok) {
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${rows.length}`);
    }
    await sleep(60); // suave con el rate limit
  }
  console.log(`Listo: ${done} re-embebidos, ${failed} fallidos.`);
  if (failed > 0) console.log('Vuelve a correr "npm run reembed" para reintentar los fallidos.');
}

main().catch((err) => {
  console.error('Fallo en reembed:', err);
  process.exit(1);
});
