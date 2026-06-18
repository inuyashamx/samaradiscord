import 'dotenv/config';

/** Lanza un error claro si falta una variable requerida (se llama al usarla). */
export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Revisa tu archivo .env`);
  }
  return value;
}

// No lanzamos nada al importar: así el chat local funciona sin credenciales de
// Discord, y Discord no exige nada hasta que arrancas el bot. Cada entrypoint
// valida lo que de verdad necesita (ver assertDiscordConfig / OpenAIProvider).
export const config = {
  discord: {
    get token() {
      return required('DISCORD_TOKEN');
    },
    get appId() {
      return required('DISCORD_APP_ID');
    },
    guildId: process.env.DISCORD_GUILD_ID || undefined,
    // Desarrollador: con él Samara es franca (incluso en lo técnico).
    // Por ID numérico (lo más fiable) o por nombre/usuario (más cómodo).
    devUserId: process.env.DEV_USER_ID || undefined,
    devUserName: process.env.DEV_USER_NAME || undefined,
  },
  openai: {
    get apiKey() {
      return required('OPENAI_API_KEY');
    },
    model: process.env.OPENAI_MODEL || 'gpt-4o',
    // Modelo barato para la decisión de "¿me meto en esta conversación?".
    decisionModel: process.env.OPENAI_DECISION_MODEL || 'gpt-4o-mini',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
  },
  behavior: {
    shortTermWindow: Number(process.env.SHORT_TERM_WINDOW ?? 40),
    // Cuántos mensajes de otros deben pasar tras hablar ella para que vuelva a
    // meterse sola SIN que le hablen directo (evita monopolizar en grupo).
    // No aplica cuando el mensaje va dirigido a ella: ahí siempre contesta.
    ambientMinGap: Number(process.env.AMBIENT_MIN_GAP ?? 1),
    // Iniciativa propia: si un canal queda en silencio un rato (segundos),
    // Samara considera romper el silencio / hacer plática. Se elige un tiempo
    // al azar entre min y max para que se sienta esporádico. 0 = desactivado.
    proactiveIdleMinSec: Number(process.env.PROACTIVE_IDLE_MIN_SEC ?? 60),
    proactiveIdleMaxSec: Number(process.env.PROACTIVE_IDLE_MAX_SEC ?? 240),
    // Reflexión: cada cuántas interacciones Samara "repasa" lo vivido y saca
    // conclusiones/opiniones propias que guarda como recuerdos. 0 = desactivado.
    reflectionEvery: Number(process.env.REFLECTION_EVERY ?? 12),
    // Olvido: al reflexionar, conserva los N recuerdos episódicos más recientes
    // y olvida los viejos que sobran (lo importante ya quedó en sus reflexiones).
    // Umbral ALTO a propósito: con pocos recuerdos cada uno vale, así que solo
    // poda cuando ya tiene una montaña. Las reflexiones nunca se borran.
    // 0 = no olvidar nunca. Baja el número si quieres que olvide antes.
    memoryKeepEpisodic: Number(process.env.MEMORY_KEEP_EPISODIC ?? 5000),
    // Estilo de "chat real": fuerza minúsculas, sin acentos/puntos/signos de
    // apertura. El modelo no obedece esto solo, así que se aplica al texto.
    // Pon CASUAL_STYLE=false para escritura normal con ortografía.
    casualStyle: (process.env.CASUAL_STYLE ?? 'true').toLowerCase() !== 'false',
  },
} as const;
