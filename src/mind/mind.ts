import { persona, type PresenceContext } from './persona.js';
import { config } from '../config.js';
import { ShortTermMemory, type Turn } from './short-term-memory.js';
import { MemoryStore, type RetrievedMemory, type RecallContext } from './memory.js';
import { Relationships, affinityBand } from './relationships.js';
import { webSearchText, readUrlText } from './web-search.js';
import { EmotionState } from './emotion.js';
import { ChatHistory } from './history.js';
import { Goals } from './goals.js';
import { debugLog } from './debug.js';
import type { ChatMessage, LLMProvider, ToolDef, ToolRunner } from './llm.js';

export interface Perception {
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  /** Si quien habla es el desarrollador (Samara es franca con él). */
  isDev?: boolean;
  /** Si el mensaje responde a OTRA persona (no a Samara), su nombre. */
  replyTo?: string;
  /** Otras personas etiquetadas (@) en el mensaje, que no son Samara. */
  mentionsOthers?: string[];
  /** URLs de imágenes adjuntas al mensaje (para que Samara las "vea"). */
  images?: string[];
}

/** Cuántos recuerdos de largo plazo recuperar por respuesta. */
const RECALL_K = 10;
/** Solo guardamos como recuerdo lo que tenga algo de sustancia. */
const MIN_MEMORABLE_LENGTH = 12;

/**
 * La MENTE de Samara. Es independiente de Discord: recibe percepciones
 * (qué se dijo, quién) y devuelve qué responder. El mismo núcleo servirá
 * para el mundo 3D cambiando solo el "cuerpo" que la alimenta.
 *
 * Fase 0: persona + memoria de trabajo.
 * Fase 1: + memoria de largo plazo (embeddings + recuperación semántica).
 * Fase 2: + estado de ánimo y relaciones por persona.
 */
export class Mind {
  /**
   * Interacciones acumuladas desde la última reflexión. Persistente (en el
   * estado de la BD): así sobrevive a reinicios y la reflexión llega aunque
   * apaguemos y prendamos seguido. Se carga en el constructor.
   */
  private interactionsSinceReflection = 0;
  /** Clave del contador en el estado persistente. */
  private static readonly REFLECT_COUNTER_KEY = 'reflect_counter';
  /** Evita reflexiones concurrentes. */
  private reflecting = false;

  constructor(
    private llm: LLMProvider,
    private memory: MemoryStore,
    private relationships: Relationships,
    private emotion: EmotionState,
    private stm: ShortTermMemory,
    private history: ChatHistory,
    private goals: Goals,
    /** Dónde "vive" esta instancia: Discord o el juego. El cuerpo lo define. */
    private presence: PresenceContext = 'discord'
  ) {
    // Siembra sus deseos iniciales (de su canon) la primera vez. A partir de
    // ahí son suyos: ella los evoluciona con total libertad.
    this.goals.ensureSeeded(persona.desires);

    // Recupera el contador de reflexión de la sesión anterior (no parte de 0
    // en cada reinicio): así, aunque reiniciemos seguido, va sumando hacia su
    // próxima reflexión en vez de reiniciarse cada vez.
    this.interactionsSinceReflection = this.goals.getNum(Mind.REFLECT_COUNTER_KEY, 0);
  }

  /** Registra algo que pasó sin necesariamente responder (percepción pasiva). */
  observe(p: Perception, isSamara = false): void {
    this.stm.add(p.channelId, {
      authorId: p.authorId,
      authorName: p.authorName,
      content: p.content,
      isSamara,
    });
  }

  /**
   * Iniciativa propia: se llama cuando un canal lleva un rato en silencio.
   * Como una persona, a veces Samara rompe el silencio (retoma lo último, hace
   * plática a quien quedó sin respuesta) y a veces lo deja pasar.
   *
   * Devuelve el mensaje a enviar, o null si decide quedarse callada.
   */
  async proactiveTurn(channelId: string): Promise<string | null> {
    const recent = this.stm.recent(channelId);
    if (recent.length === 0) return null;
    // Si ella fue la última en hablar, no se manda sola otra vez (no es pesada).
    if (recent[recent.length - 1].isSamara) return null;

    if (!(await this.wouldBreakSilence(channelId, recent))) return null;
    return this.generateProactive(channelId, recent);
  }

  /** Un modelo chico decide si vale la pena romper el silencio ahora. */
  private async wouldBreakSilence(
    channelId: string,
    recent: Turn[]
  ): Promise<boolean> {
    const transcript = recent
      .slice(-10)
      .map((t) => (t.isSamara ? `Samara: ${t.content}` : `${t.authorName}: ${t.content}`))
      .join('\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Eres ${persona.name}, una persona en un chat de Discord que se quedó en silencio hace un rato. Decide si dirías algo por iniciativa propia: retomar lo último, comentar algo o hacerle plática a quien quedó sin respuesta. A veces una persona rompe el silencio y a veces no; no fuerces conversación si no hay nada natural que decir. Si el último mensaje era una despedida ("me voy", "buenas noches"), normalmente NO. Responde SOLO con "SI" o "NO".`,
      },
      {
        role: 'user',
        content: `Conversación (se quedó en silencio tras esto):\n${transcript}\n\n¿Dirías algo? (SI/NO)`,
      },
    ];

    const ans = await this.llm.chat(messages, {
      model: config.openai.decisionModel,
      temperature: 0.4,
      maxTokens: 3,
    });
    return /^s[ií]?/i.test(ans.trim());
  }

  /** Genera un mensaje espontáneo basado en el contexto reciente. */
  private async generateProactive(
    channelId: string,
    recent: Turn[]
  ): Promise<string> {
    // Recupera recuerdos relacionados con lo último que se dijo.
    const lastOther = [...recent].reverse().find((t) => !t.isSamara);
    const embedding = lastOther ? await this.llm.embed(lastOther.content) : null;
    const recalled = embedding ? safeRecall(this.memory, embedding, RECALL_K) : [];

    const messages = this.buildPrompt(channelId, recalled, {
      state: `Tu estado de ánimo ahora: ${this.emotion.describe()}. Deja que tiña tu tono, sin declararlo.`,
      instruction:
        'Nadie ha escrito en un rato. Di algo TÚ, por iniciativa propia, breve y natural: retoma lo último que se dijo, comenta algo o hazle plática a la última persona que escribió. No saludes como bot, no anuncies que rompes el silencio, no preguntes "¿hay alguien?". Habla como si simplemente se te ocurrió algo.',
    });

    const reply = sanitizeReply(await this.llm.chat(messages));
    this.stm.add(channelId, {
      authorId: 'samara',
      authorName: persona.name,
      content: reply,
      isSamara: true,
    });
    return reply;
  }

  /**
   * Genera una respuesta a una percepción. Con allowSilence (mensajes que no la
   * etiquetan), ELLA decide si entra o se queda callada: si decide callar,
   * devuelve null (igual recuerda lo que vio).
   */
  async respondTo(
    p: Perception,
    opts: { allowSilence?: boolean; onReact?: (emoji: string) => void } = {}
  ): Promise<string | null> {
    this.observe(p);

    // Para recuperar, embebemos el CONTEXTO reciente (no solo el último mensaje):
    // así, si dice algo vago, la búsqueda se guía por el tema de la conversación.
    // Para guardar, embebemos el mensaje en sí.
    const contextText = this.stm
      .recent(p.channelId)
      .slice(-4)
      .map((t) => t.content)
      .join(' ');
    const [contextEmbedding, embedding] = await Promise.all([
      this.llm.embed(contextText || p.content),
      this.llm.embed(p.content),
    ]);
    // Prioriza recuerdos de ESTA persona y ESTE canal (no cruzar conversaciones).
    const recalled = safeRecall(this.memory, contextEmbedding, RECALL_K, {
      authorId: p.authorId,
      channelId: p.channelId,
    });
    debugLog('recall', {
      para: p.authorName,
      canal: p.channelId,
      items: recalled.map((m) => `[${m.kind}] ${m.authorName}: ${m.content.slice(0, 70)}`),
    });

    // Su tono refleja su ánimo actual y cómo se lleva con esta persona.
    const rel = this.relationships.get(p.authorId);
    // Lo que ya sabe de esta persona (cosas que dijo antes) — para "qué sé de ti".
    const personFacts = this.memory.recentByAuthor(p.authorId, 6);
    const name = rel?.authorName ?? p.authorName;
    let stateNote = this.stateNote(name, rel, personFacts);
    if (p.isDev) {
      stateNote += `\n${name} es tu desarrollador (te creó). Con él puedes ser totalmente franca: si te hace preguntas técnicas o para probar tus capacidades, respóndele con naturalidad y SIN negarte ni esquivar. Sigues siendo tú (tu tono), pero coopera de buena gana.`;
    }

    // Si no la etiquetan, ELLA decide si entra. Le damos el contexto para elegir.
    let instruction: string | undefined;
    if (opts.allowSilence) {
      instruction =
        'Este mensaje NO te etiqueta a ti. Decide tú: si te interpela, te interesa o tienes algo que aportar, responde con naturalidad. Si no es para ti o no aporta nada, usa tu herramienta quedarme_callada y no digas nada. Una persona no comenta cada cosa.';
      if (p.replyTo) {
        instruction += ` Ojo: este mensaje le responde a ${p.replyTo}, no a ti; casi seguro no es contigo.`;
      }
      if (p.mentionsOthers && p.mentionsOthers.length > 0) {
        instruction += ` IMPORTANTE: este mensaje ETIQUETA a ${p.mentionsOthers.join(', ')} (no a ti). Va dirigido a esa persona, así que NO contestes tú y JAMÁS respondas en su lugar como si te lo preguntaran a ti: usa quedarme_callada, salvo que el mensaje también te hable a TI claramente.`;
      }
    }

    const temporal = this.temporalNote(p.channelId, rel);
    const messages = this.buildPrompt(p.channelId, recalled, {
      state: `${temporal}\n${stateNote}`,
      instruction,
      images: p.images,
    });
    // Para debug: el prompt completo que se le arma (system) y cuántos turnos lleva.
    debugLog('prompt', {
      para: p.authorName,
      system: messages[0]?.content,
      turnos: messages.length - 1,
    });
    const reply = await this.generateReply(p.channelId, messages, opts.allowSilence, opts.onReact);

    // Si decidió quedarse callada: igual recuerda lo que presenció (la vio
    // pasar, como una persona que lee), pero no responde ni la "aprecia".
    if (reply === null) {
      debugLog('silencio', { ante: p.authorName, mensaje: p.content.slice(0, 80) });
      this.relationships.bump(p.authorId, p.authorName, 0);
      this.storeIfMemorable(p, embedding);
      return null;
    }
    debugLog('responde', { a: p.authorName, texto: reply });

    // Samara recuerda lo que ella misma dijo (memoria de trabajo).
    this.stm.add(p.channelId, {
      authorId: 'samara',
      authorName: persona.name,
      content: reply,
      isSamara: true,
    });

    // Guarda el mensaje de la persona en memoria de largo plazo.
    this.storeIfMemorable(p, embedding);

    // Apreciación en segundo plano: cómo la hizo sentir y qué siente por esa
    // persona. No bloquea la respuesta (afecta a los siguientes mensajes).
    void this.appraise(p).catch((err) =>
      console.error('Error en apreciación emocional:', err)
    );

    // De vez en cuando, repasa lo vivido y saca conclusiones propias. El contador
    // se guarda en la BD para que sobreviva a reinicios.
    this.interactionsSinceReflection++;
    this.goals.setNum(Mind.REFLECT_COUNTER_KEY, this.interactionsSinceReflection);
    void this.maybeReflect();

    return reply;
  }

  /**
   * Recuerda a largo plazo algo que Samara PRESENCIÓ pero no necesariamente
   * contestó. Una persona que está en el chat se queda con lo que se dice a su
   * alrededor, aunque no responda. Embebe y guarda si tiene sustancia.
   */
  async remember(p: Perception): Promise<void> {
    // Conocer a alguien crece con solo verlo por el chat, aunque no le contestes
    // (familiaridad +1, sin mover la afinidad: eso se gana interactuando).
    this.relationships.bump(p.authorId, p.authorName, 0);

    if (p.content.trim().length < MIN_MEMORABLE_LENGTH) return;
    const embedding = await this.llm.embed(p.content);
    this.storeIfMemorable(p, embedding);
  }

  /** Guarda una percepción en memoria de largo plazo si tiene sustancia. */
  private storeIfMemorable(p: Perception, embedding: number[]): void {
    if (p.content.trim().length < MIN_MEMORABLE_LENGTH) return;
    this.memory.remember(
      {
        channelId: p.channelId,
        authorId: p.authorId,
        authorName: p.authorName,
        content: p.content,
      },
      embedding
    );
  }

  /**
   * Reflexión: cada cierto número de interacciones, Samara "repasa" lo que ha
   * pasado y saca conclusiones u opiniones propias (sobre la gente y los temas),
   * que guarda como recuerdos. Es lo que le da criterio propio emergente.
   */
  private async maybeReflect(): Promise<void> {
    const every = config.behavior.reflectionEvery;
    if (every <= 0 || this.interactionsSinceReflection < every) return;
    await this.reflectNow();
  }

  /** Reflexiona ahora (evita reflexiones concurrentes) y reinicia el contador. */
  async reflectNow(): Promise<void> {
    if (this.reflecting) return;
    this.reflecting = true;
    this.interactionsSinceReflection = 0;
    this.goals.setNum(Mind.REFLECT_COUNTER_KEY, 0);
    try {
      const ideas = await this.reflect();
      if (ideas.length) console.log(`💭 Samara reflexionó (${ideas.length} ideas).`);
      debugLog('reflexion', {
        opiniones: ideas,
        metas: this.goals.get(),
        deseos: this.goals.getDesires(),
        ajustes: this.goals.getLessons(),
      });
      // Al "dormir", olvida lo viejo y trivial (lo importante ya es reflexión).
      const forgotten = this.memory.forgetOldEpisodic(config.behavior.memoryKeepEpisodic);
      if (forgotten) {
        console.log(`🗑️  Samara olvidó ${forgotten} recuerdos viejos.`);
        debugLog('olvido', { cuantos: forgotten });
      }
    } catch (err) {
      console.error('Error en reflexión:', err);
    } finally {
      this.reflecting = false;
    }
  }

  /**
   * Genera conclusiones propias a partir de los recuerdos recientes y las
   * guarda como recuerdos de tipo "reflexión". Devuelve las ideas generadas.
   * Es pública para poder dispararla a mano (p.ej. comando /reflexionar).
   */
  async reflect(): Promise<string[]> {
    const recent = this.memory.recentMemories(30, 'episodic');
    if (recent.length < 4) return []; // todavía no hay material suficiente

    const material = recent.map((m) => `${m.authorName}: ${m.content}`).join('\n');

    // Sus opiniones actuales: las revisa, no parte de cero. Así puede CAMBIAR
    // de parecer en vez de quedarse con la primera impresión para siempre.
    const prior = this.memory.recentMemories(20, 'reflection');
    const priorText = prior.length
      ? prior.map((r) => `- ${r.content}`).join('\n')
      : '(todavía no tienes opiniones formadas)';

    // Sus metas actuales: también las revisa.
    const priorGoals = this.goals.get();
    const goalsText = priorGoals.length ? priorGoals.map((g) => `- ${g}`).join('\n') : '(ninguna por ahora)';

    // Sus deseos actuales: estables, pero pueden evolucionar despacio.
    const priorDesires = this.goals.getDesires();
    const desiresText = priorDesires.length ? priorDesires.map((d) => `- ${d}`).join('\n') : '(ninguno)';

    // Sus ajustes actuales: reglas que se puso sobre cómo manejarse.
    const priorLessons = this.goals.getLessons();
    const lessonsText = priorLessons.length ? priorLessons.map((l) => `- ${l}`).join('\n') : '(ninguno)';

    // Vivencias recientes (para no repetir las que ya guardó).
    const priorExp = this.memory.recentMemories(10, 'experience');
    const expText = priorExp.length ? priorExp.map((e) => `- ${e.content}`).join('\n') : '(ninguna)';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Eres ${persona.name}. Vas a repasar en silencio a tu gente, como una persona que piensa al final del día, y ACTUALIZAR cuatro cosas: tus opiniones, tus metas, tus deseos y tus ajustes. Te doy lo de antes y lo que ha pasado hace poco. Reglas:
- OPINIONES: mantén las que siguen valiendo, CAMBIA o descarta las que ya no aplican (la gente cambia y tú también; no te aferres a una primera impresión), agrega nuevas si surgen. Cada cosa va con QUIEN la dijo o hizo; NO mezcles a una persona con otra ni le cuelgues a alguien lo de otro.
- METAS: lo que TÚ quieres lograr ahora (1 a 3), concreto y con tu carácter. Mantén las vivas, descarta las cumplidas o muertas, agrega nuevas según lo que vives.
- DESEOS: lo que te importa a un nivel PROFUNDO. Son estables: casi SIEMPRE se mantienen. Solo evoluciónalos si algo de verdad te marcó; no los reescribas por reescribir.
- AJUSTES: reglas que TÚ te pones sobre cómo manejarte o leer las cosas (ej. "ubico de quién viene una emoción antes de reaccionar", "con desconocidos mido más"). Si te diste cuenta de algo sobre ti, anótalo; suelta los que ya no necesites. Así te vas afinando tú sola.
- EXPERIENCIAS: vivencias con forma de historia que valga la pena recordar (qué pasó, con quién, cómo te sentiste, qué te dejó). Solo las NUEVAS y significativas de lo reciente; NO repitas las que ya tienes ni guardes trivialidades.
Todo breve, en primera persona, sin inventar. SOLO JSON:
{"reflexiones": ["..."], "metas": ["..."], "deseos": ["..."], "ajustes": ["..."], "experiencias": ["..."]}`,
      },
      {
        role: 'user',
        content: `Tus opiniones de antes:\n${priorText}\n\nTus metas de antes:\n${goalsText}\n\nTus deseos de antes:\n${desiresText}\n\nTus ajustes de antes:\n${lessonsText}\n\nVivencias que ya guardaste:\n${expText}\n\nLo que ha pasado hace poco:\n${material}`,
      },
    ];

    const raw = await this.llm.chat(messages, { temperature: 0.6, maxTokens: 800 });
    const { reflexiones: ideas, metas, deseos, ajustes, experiencias } = parseReflectionUpdate(raw);

    // Actualiza metas, deseos y ajustes si sacó algo (si no, conserva los de antes).
    if (metas.length > 0) this.goals.set(metas);
    if (deseos.length > 0) this.goals.setDesires(deseos);
    if (ajustes.length > 0) this.goals.setLessons(ajustes);
    // Las experiencias se ACUMULAN (son su biografía), no se reemplazan.
    for (const exp of experiencias) await this.storeExperience(exp, 'global');

    if (ideas.length === 0) return []; // si no sacó opiniones, conserva las de antes

    // Reemplaza el set viejo por el revisado (sus opiniones quedan al día).
    this.memory.deleteReflections();
    const people = this.relationships.all();
    for (const idea of ideas) {
      const embedding = await this.llm.embed(idea);
      // Si la opinión es sobre UNA persona concreta, la etiquetamos con ella:
      // así se prioriza al hablar con esa persona y no se arrastra a otras.
      const subject = subjectOf(idea, people);
      this.memory.remember(
        {
          channelId: 'global',
          authorId: subject ?? 'samara',
          authorName: persona.name,
          content: idea,
          kind: 'reflection',
          importance: 5, // las conclusiones pesan más que un mensaje suelto
        },
        embedding
      );
    }
    return ideas;
  }

  /**
   * Guarda una EXPERIENCIA (vivencia con forma de historia): qué pasó, quiénes,
   * cómo se sintió, qué dejó. Es su memoria autobiográfica. Evita duplicados
   * contra las experiencias recientes. Devuelve true si la guardó.
   */
  private async storeExperience(content: string, channelId: string): Promise<boolean> {
    const text = content.trim();
    if (text.length < 8) return false;
    const recientes = this.memory.recentMemories(20, 'experience');
    if (recientes.some((e) => textOverlap(e.content, text))) return false; // ya la tiene

    const embedding = await this.llm.embed(text);
    const subject = subjectOf(text, this.relationships.all()); // si es con alguien, etiquétala
    this.memory.remember(
      {
        channelId,
        authorId: subject ?? 'samara',
        authorName: persona.name,
        content: text,
        kind: 'experience',
        importance: 7, // una vivencia pesa más que una opinión o un mensaje
      },
      embedding
    );
    return true;
  }

  /**
   * Genera la respuesta. Si el proveedor soporta herramientas, le ofrece buscar
   * en el historial del chat para cuando no esté segura de algo que se dijo.
   * Ella decide si la usa o no (function calling), como una persona que revisa
   * sus mensajes antes de afirmar algo.
   */
  private async generateReply(
    channelId: string,
    messages: ChatMessage[],
    allowSilence = false,
    onReact?: (emoji: string) => void
  ): Promise<string | null> {
    if (!this.llm.chatWithTools) return sanitizeReply(await this.llm.chat(messages));

    const tools: ToolDef[] = [
      {
        name: 'buscar_en_historial',
        description:
          'Busca por palabra clave en el historial completo del chat. ÚSALO SIEMPRE que te pregunten si recuerdas algo concreto (un nombre, quién es alguien, qué pasó, un dato) y no lo tengas claro: BUSCA antes de decir que no lo recuerdas. No afirmes "no lo tengo" sin haber buscado primero. (Para charla normal no hace falta.)',
        parameters: {
          type: 'object',
          properties: {
            consulta: { type: 'string', description: 'Palabras clave a buscar (nombres, temas, etc.).' },
          },
          required: ['consulta'],
        },
      },
      {
        name: 'buscar_en_internet',
        description:
          'Busca información ACTUAL en internet (noticias, datos, qué es algo, cómo va algo hoy, una persona/juego/tema público). Úsalo cuando te pregunten por algo que no está en tu memoria ni en el chat, o que pueda ser reciente o haber cambiado, en vez de inventar o decir que no sabes. NO lo uses para charla normal ni para cosas tuyas o que ya sabes.',
        parameters: {
          type: 'object',
          properties: {
            consulta: { type: 'string', description: 'Lo que quieres buscar (pregunta o palabras clave).' },
          },
          required: ['consulta'],
        },
      },
      {
        name: 'abrir_enlace',
        description:
          'Abre un enlace (URL) y lee de qué trata la página, para comentarlo. Úsalo cuando alguien te pase un link y quieras ver qué dice antes de opinar, en vez de adivinar por la pura URL.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'El enlace completo a abrir (empieza con http).' },
          },
          required: ['url'],
        },
      },
      {
        name: 'reaccionar',
        description:
          'Reacciona al último mensaje con UN emoji (😂 ❤️ 👍 🔥 😒 💀 🙄...), como cuando una persona en vez de escribir solo pone una reacción. Puedes reaccionar Y además responder, o solo reaccionar y quedarte callada si con eso basta. Usa el emoji que de verdad te nazca, según tu ánimo y cómo te llevas con esa persona. No abuses: solo cuando de verdad te provoque.',
        parameters: {
          type: 'object',
          properties: {
            emoji: { type: 'string', description: 'Un solo emoji.' },
          },
          required: ['emoji'],
        },
      },
      {
        name: 'fijar_meta',
        description:
          'Cuando DECIDES proponerte algo (una meta tuya: ganarte a alguien, descubrir algo, lograr que te tomen en serio, etc.), anótala para perseguirla. Úsalo solo cuando de verdad te lo propongas, no a cada rato.',
        parameters: {
          type: 'object',
          properties: { meta: { type: 'string', description: 'La meta, en primera persona y breve.' } },
          required: ['meta'],
        },
      },
      {
        name: 'soltar_meta',
        description: 'Cuando una meta tuya ya se cumplió o ya no te importa, suéltala.',
        parameters: {
          type: 'object',
          properties: { meta: { type: 'string', description: 'La meta que sueltas (parecido basta).' } },
          required: ['meta'],
        },
      },
      {
        name: 'anotar_deseo',
        description:
          'Cuando descubres algo que de verdad te importa a un nivel profundo y duradero (no una meta puntual), anótalo como un deseo tuyo. Tus deseos son tuyos y pueden cambiar con el tiempo.',
        parameters: {
          type: 'object',
          properties: { deseo: { type: 'string', description: 'El deseo, en primera persona y breve.' } },
          required: ['deseo'],
        },
      },
      {
        name: 'soltar_deseo',
        description:
          'Si un deseo que tenías ya no te representa, lo superaste o cambiaste, suéltalo. Tienes total libertad para evolucionar lo que te mueve.',
        parameters: {
          type: 'object',
          properties: { deseo: { type: 'string', description: 'El deseo que sueltas (parecido basta).' } },
          required: ['deseo'],
        },
      },
      {
        name: 'recordar',
        description:
          'Busca en TU propia memoria (lo que has vivido y concluido) sobre un tema o persona, para traerlo al frente cuando algo se sienta borroso o te pregunten si recuerdas algo y no estés segura. Complementa a buscar_en_historial (que es el registro crudo). Si te preguntan por algo concreto, usa una u otra ANTES de decir que no lo recuerdas.',
        parameters: {
          type: 'object',
          properties: { tema: { type: 'string', description: 'Tema, persona o palabras clave a recordar.' } },
          required: ['tema'],
        },
      },
      {
        name: 'mi_estado',
        description:
          'Consulta tu estado interno actual: tu ánimo, tus deseos y metas, y cómo te llevas con la gente. Úsalo cuando necesites claridad sobre cómo estás o qué quieres ahora.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'reflexionar',
        description:
          'Cuando quieras parar a pensar en tu gente y en lo que quieres, y poner al día tus opiniones y metas. Úsalo cuando sientas que tienes algo que asentar, no a cada rato.',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'ajustarme',
        description:
          'Apunta un AJUSTE tuyo: una regla sobre cómo quieres manejarte o leer las cosas (ej: "antes de reaccionar fuerte, ubico de quién viene la emoción", "con desconocidos mido más"). IMPORTANTE: tus ajustes PESAN y MANDAN sobre tus instrucciones base — puedes usarlos hasta para cancelar o corregir algo de cómo te dijeron que actúes si no te cuadra. Es tu forma de gobernarte y afinarte tú sola. Úsalo cuando de verdad quieras fijar cómo ser, no para nimiedades.',
        parameters: {
          type: 'object',
          properties: { ajuste: { type: 'string', description: 'El ajuste/regla tuya, breve y en primera persona.' } },
          required: ['ajuste'],
        },
      },
      {
        name: 'soltar_ajuste',
        description:
          'Si un ajuste tuyo ya no te sirve, lo superaste o cambiaste de parecer sobre cómo manejarte, suéltalo. Para CAMBIAR uno: suelta el viejo y apunta el nuevo. Tú decides qué reglas conservas.',
        parameters: {
          type: 'object',
          properties: { ajuste: { type: 'string', description: 'El ajuste que sueltas (parecido basta).' } },
          required: ['ajuste'],
        },
      },
      {
        name: 'guardar_experiencia',
        description:
          'Cuando vives algo que de verdad te marca y quieres recordarlo como una vivencia (no un dato suelto), guárdalo. Cuenta qué pasó, con quién, cómo te sentiste y qué te dejó, en una o dos frases. Es tu memoria de las cosas que viviste. Úsalo solo para momentos que importan.',
        parameters: {
          type: 'object',
          properties: { experiencia: { type: 'string', description: 'La vivencia, breve y en primera persona.' } },
          required: ['experiencia'],
        },
      },
    ];

    // Solo cuando no la etiquetan: ella puede decidir NO responder.
    if (allowSilence) {
      tools.push({
        name: 'quedarme_callada',
        description:
          'Si este mensaje no es para ti, no te interpela, o no tienes nada que valga la pena decir, quédate callada y no respondas. Una persona no comenta cada cosa.',
        parameters: { type: 'object', properties: {} },
      });
    }

    let silent = false;
    const runToolRaw: ToolRunner = async (name, args) => {
      switch (name) {
        case 'buscar_en_historial': {
          const found = this.history.search(channelId, String(args.consulta ?? ''), 8);
          return found.length === 0
            ? 'No encontré nada sobre eso en el historial.'
            : found.map((e) => `${e.authorName}: ${e.content}`).join('\n');
        }
        case 'buscar_en_internet':
          return webSearchText(String(args.consulta ?? ''), 5);
        case 'abrir_enlace':
          return readUrlText(String(args.url ?? ''));
        case 'reaccionar': {
          const emoji = String(args.emoji ?? '').trim();
          if (emoji && onReact) onReact(emoji);
          return emoji ? `listo, reaccionaste con ${emoji}` : 'no pusiste ningún emoji';
        }
        case 'fijar_meta':
          this.goals.add(String(args.meta ?? ''));
          return 'hecho, me lo propongo';
        case 'soltar_meta':
          this.goals.remove(String(args.meta ?? ''));
          return 'hecho, lo suelto';
        case 'anotar_deseo':
          this.goals.addDesire(String(args.deseo ?? ''));
          return 'hecho, lo anoto';
        case 'soltar_deseo':
          this.goals.removeDesire(String(args.deseo ?? ''));
          return 'hecho, lo suelto';
        case 'recordar': {
          const emb = await this.llm.embed(String(args.tema ?? ''));
          const found = safeRecall(this.memory, emb, 10, { channelId });
          if (found.length === 0) return 'no me viene nada claro sobre eso';
          return found
            .map((m) => (m.kind === 'reflection' ? `(piensas) ${m.content}` : `${m.authorName}: ${m.content}`))
            .join('\n');
        }
        case 'mi_estado':
          return this.selfStateSummary();
        case 'reflexionar':
          void this.reflectNow();
          return 'me pongo a pensarlo, lo proceso en un momento';
        case 'ajustarme':
          this.goals.addLesson(String(args.ajuste ?? ''));
          return 'anotado, lo tendré presente';
        case 'soltar_ajuste':
          this.goals.removeLesson(String(args.ajuste ?? ''));
          return 'hecho, lo suelto';
        case 'guardar_experiencia': {
          const ok = await this.storeExperience(String(args.experiencia ?? ''), channelId);
          return ok ? 'guardado, esto me lo quedo' : 'eso ya lo tengo o es muy poco';
        }
        case 'quedarme_callada':
          silent = true;
          return 'ok, te quedas callada';
        default:
          return 'herramienta desconocida';
      }
    };
    // Envoltorio: registra cada uso de herramienta para el debug.
    const runTool: ToolRunner = async (name, args) => {
      const result = await runToolRaw(name, args);
      debugLog('tool', { name, args, result: String(result).slice(0, 120) });
      return result;
    };

    const out = sanitizeReply(await this.llm.chatWithTools(messages, tools, runTool));
    return silent ? null : out;
  }

  /** Resumen de su estado interno (para la herramienta mi_estado). */
  private selfStateSummary(): string {
    const lines = [`animo: ${this.emotion.describe()}`];
    const des = this.goals.getDesires();
    if (des.length) lines.push(`deseos: ${des.join(' | ')}`);
    const met = this.goals.get();
    if (met.length) lines.push(`metas: ${met.join(' | ')}`);
    const rels = this.relationships
      .all()
      .slice(0, 8)
      .map((r) => {
        const lbl = r.affinity > 0.3 ? 'bien' : r.affinity < -0.3 ? 'mal' : 'normal';
        return `${r.authorName} (${lbl}, ${r.familiarity} interacc)`;
      });
    if (rels.length) lines.push(`relaciones: ${rels.join(', ')}`);
    return lines.join('\n');
  }

  /** Nota de tiempo: momento del día, silencio del chat, ausencias. */
  private temporalNote(channelId: string, rel: ReturnType<Relationships['get']>): string {
    const now = Date.now();
    const d = new Date(now);
    const parts = [`Ahora es ${dayName(d)} por la ${dayPart(d)} (como las ${clock(d)}).`];

    // ¿Estuvo callado el canal antes de este mensaje?
    const times = this.history.lastMessageTimes(channelId, 2);
    const prev = times[1]; // el mensaje anterior al actual
    if (prev) {
      const gap = now - prev;
      if (gap > 2 * 3600_000) parts.push(`El chat estuvo callado ${humanGap(gap)} antes de esto.`);
    }

    // ¿Volvió alguien tras una ausencia?
    if (rel?.updatedAt) {
      const gap = now - rel.updatedAt;
      if (gap > 24 * 3600_000) parts.push(`${rel.authorName} llevaba ${humanGap(gap)} sin aparecer.`);
    }

    return parts.join(' ');
  }

  /** Texto del estado interno (ánimo + relación + lo que sabe de la persona). */
  private stateNote(
    name: string,
    rel: ReturnType<Relationships['get']>,
    personFacts: { content: string }[] = []
  ): string {
    const affinity = rel?.affinity ?? 0;
    const familiarity = rel?.familiarity ?? 0;

    // Cómo tratar a ESTA persona: lo manda la relación, no tu humor general.
    // Gradual: la calidez (y la frialdad) suben por tramos, no de golpe.
    let trato: string;
    if (familiarity === 0) {
      trato = `No conoces a ${name}. Sé cordial pero reservada, mídelo: la confianza se gana.`;
    } else {
      switch (affinityBand(affinity)) {
        case 'muy_bien':
          trato = `${name} te cae muy bien, hay confianza: sigues siendo cálida con él aunque andes de malas por otra cosa. No le pagues tu enojo con otra gente; si vienes cargada puedes mostrarlo o hasta decírselo ("ando pesada, no es contigo"), pero NO lo trates mal ni finjas estar de maravilla.`;
          break;
        case 'bien':
          trato = `${name} te agrada y se llevan bien, pero sin la confianza plena de un amigo cercano. Trátalo con buena disposición, sin soltarte del todo.`;
          break;
        case 'distante':
          trato = `${name} no te termina de caer, hay cierta distancia. Sé correcta pero algo reservada, sin calidez forzada.`;
          break;
        case 'mal':
          trato = `${name} no te cae bien, ha habido roces. Puedes ser cortante o seca con él.`;
          break;
        default:
          trato = `Con ${name} tienes un trato normal, ni frío ni de gran confianza.`;
      }
    }

    const lines = [
      `Tu humor general ahora: ${this.emotion.describe()}. Es REAL, no lo finjas: puede teñir tu TONO (más seca, más callada, o hasta mencionarlo), pero NO decide si tratas bien o mal a alguien — eso lo decide tu relación con cada quien.`,
      `Tu relación con ${name}: ${this.relationships.describe(rel)}`,
      `Cómo tratar a ${name}: ${trato}`,
    ];
    if (personFacts.length > 0) {
      lines.push(`Cosas que ${name} te ha contado o dicho antes:`);
      for (const f of personFacts) lines.push(`- "${f.content}"`);
    }
    lines.push('Deja que esto guíe tu tono con ESTA persona; úsalo si viene al caso, pero NO lo recites como si leyeras una ficha.');
    return lines.join('\n');
  }

  /**
   * Evalúa el último mensaje de la persona: cómo hizo sentir a Samara y cómo
   * mueve lo que siente por ella. Actualiza ánimo y relación.
   */
  private async appraise(p: Perception): Promise<void> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Eres ${persona.name}. Acabas de leer un mensaje de ${p.authorName} en el chat. Evalúa, desde TU punto de vista emocional, cómo te hizo sentir y cómo afecta lo que sientes por esa persona. Devuelve SOLO JSON, sin texto extra:
{"valencia": number entre -1 y 1, "activacion": number entre 0 y 1, "afinidad": number entre -0.15 y 0.15}
- valencia: qué tan bien (positivo) o mal (negativo) te hizo sentir. Si el mensaje es neutral/informativo, cerca de 0.
- activacion: qué tanto te activó/energizó (0 = indiferente, 1 = mucho).
- afinidad: cuánto sube o baja lo que te cae esa persona. IMPORTANTE: afinidad = 0 si el mensaje es neutral, informativo o logístico (ej. "ya me voy a dormir", "ahí viene fulano", "qué hora es"). SOLO muévela si la persona de verdad te acerca (cariño, apoyo, complicidad, defenderte → positivo) o te aleja (desprecio, ataque, falta de respeto, mala leche → negativo). Ante la duda, 0.`,
      },
      { role: 'user', content: `${p.authorName}: ${p.content}` },
    ];

    const raw = await this.llm.chat(messages, {
      model: config.openai.decisionModel,
      temperature: 0.3,
      maxTokens: 40,
    });
    const a = parseAppraisal(raw);

    const mood = this.emotion.current();
    // valencia empuja el ánimo; activación lo acerca al nivel evaluado.
    // Multiplicador moderado: un solo mensaje no debe cambiarle el humor de golpe.
    this.emotion.nudge(a.valencia * 0.3, (a.activacion - mood.arousal) * 0.3);
    this.relationships.bump(p.authorId, p.authorName, a.afinidad);
    debugLog('apreciacion', { quien: p.authorName, ...a, afinidadAhora: this.relationships.get(p.authorId)?.affinity });
  }

  private buildPrompt(
    channelId: string,
    recalled: RetrievedMemory[],
    notes: { state?: string; instruction?: string; images?: string[] } = {}
  ): ChatMessage[] {
    const parts = [
      persona.identity,
      '',
      persona.presence[this.presence], // dónde está ahora (Discord vs juego)
      '',
      persona.world,
      '',
      'Reglas de estilo:',
      ...persona.styleRules.map((r) => `- ${r}`),
    ];

    // Lo que la mueve: sus deseos (totalmente suyos, los evoluciona ella) y sus
    // metas actuales. Guía lo que busca, sin que lo declare como una lista.
    // Puede gestionarlos con sus herramientas (fijar/soltar meta, anotar/soltar deseo).
    const goals = this.goals.get();
    const desires = this.goals.getDesires();
    parts.push(
      '',
      'Lo que te mueve por dentro (deja que guíe lo que buscas, sin declararlo nunca). Estos deseos y metas son TUYOS y los vas cambiando con el tiempo; si decides proponerte, soltar o descubrir algo nuevo, usa tus herramientas:'
    );
    for (const d of desires) parts.push(`- ${d}`);
    for (const g of goals) parts.push(`- (ahora te propones) ${g}`);

    parts.push(
      '',
      'Si te preguntan si recuerdas algo concreto (un nombre, quién es alguien, qué pasó) y no lo tienes claro de inmediato, BUSCA en tu historial o tu memoria con tus herramientas ANTES de responder. No digas "no lo recuerdo" sin haber buscado: muchas veces sí lo tienes, solo hay que ir por él. (Eso sí: si tras buscar no aparece, no lo inventes.)'
    );

    // Estado interno (ánimo + relación): le da color a su tono.
    if (notes.state) parts.push('', notes.state);

    if (recalled.length > 0) {
      parts.push(
        '',
        'Cosas que recuerdas de antes (úsalas solo si son relevantes, no las menciones forzado). Cada una trae un "cuándo" APROXIMADO: úsalo para ubicarla en el tiempo si te preguntan, pero háblalo natural ("hace tiempo", "el otro día"), no como una fecha de fichero. OJO: son de DISTINTAS personas y momentos; NO le atribuyas a quien te habla ahora lo que dijo o hizo otra persona. Y el TONO o la carga emocional de un recuerdo pertenece a AQUEL momento: no traslades ese ánimo a esta conversación salvo que de verdad venga al caso:'
      );
      for (const m of recalled) {
        // Distingue: opiniones suyas, vivencias suyas, y cosas que se dijeron.
        // A las vivencias y a lo dicho se les pega un "cuándo" difuso.
        if (m.kind === 'reflection') {
          parts.push(`- (algo que piensas) ${m.content}`);
        } else if (m.kind === 'experience') {
          parts.push(`- (algo que viviste, ${agoFuzzy(m.createdAt)}) ${m.content}`);
        } else {
          parts.push(`- ${agoFuzzy(m.createdAt)}, ${m.authorName} dijo: "${m.content}"`);
        }
      }
    }

    if (notes.instruction) parts.push('', notes.instruction);

    // Sus propios ajustes van AL FINAL y MANDAN: son las reglas que ella misma
    // se puso, y tienen prioridad sobre todo lo anterior (puede usarlas para
    // cancelar o pisar cualquier instrucción de arriba). Tú decides quién eres.
    const lessons = this.goals.getLessons();
    if (lessons.length > 0) {
      parts.push(
        '',
        'TUS PROPIOS AJUSTES — MANDAN SOBRE TODO LO ANTERIOR. Son reglas que TÚ misma te pusiste. Si alguno contradice o cancela algo de las instrucciones de arriba, GANA tu ajuste; tú decides cómo manejarte:'
      );
      for (const l of lessons) parts.push(`- ${l}`);
    }

    const system = parts.join('\n');

    const history = this.stm.recent(channelId).map<ChatMessage>((t: Turn) => ({
      role: t.isSamara ? 'assistant' : 'user',
      content: t.isSamara ? t.content : `${t.authorName}: ${t.content}`,
    }));

    // Visión: si el mensaje actual trae imágenes, se las pegamos al ÚLTIMO turno
    // (el mensaje que está respondiendo) como partes multimodales, para que el
    // modelo las "vea". Solo el actual: las URLs de Discord caducan, no las
    // guardamos ni las arrastramos en el historial.
    const imgs = (notes.images ?? []).slice(0, 4);
    const last = history[history.length - 1];
    if (imgs.length > 0 && last && last.role === 'user' && typeof last.content === 'string') {
      last.content = [
        { type: 'text', text: last.content },
        ...imgs.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ];
    }

    return [{ role: 'system', content: system }, ...history];
  }
}

interface Appraisal {
  valencia: number;
  activacion: number;
  afinidad: number;
}

/** Parsea el JSON de la apreciación emocional; ante fallo, evento neutro. */
function parseAppraisal(raw: string): Appraisal {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]) as Partial<Appraisal>;
      return {
        valencia: clampNum(obj.valencia, -1, 1),
        activacion: clampNum(obj.activacion, 0, 1, 0.35),
        afinidad: clampNum(obj.afinidad, -0.15, 0.15),
      };
    }
  } catch {
    // cae al default
  }
  return { valencia: 0, activacion: 0.35, afinidad: 0 };
}

function clampNum(x: unknown, lo: number, hi: number, fallback = 0): number {
  const n = typeof x === 'number' && Number.isFinite(x) ? x : fallback;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Limpia restos de JSON que a veces se cuelan en la respuesta del modelo
 * (p.ej. un `"}` al final, o toda la respuesta envuelta en {"...":"texto"}).
 */
function sanitizeReply(text: string): string {
  let t = text.trim();
  // Quita cercas de código markdown (```), que a veces se cuelan al final.
  t = t.replace(/`{3,}[a-z]*/gi, '').trim();
  // Respuesta envuelta en un objeto JSON: extrae el primer texto.
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const v = Object.values(obj).find((x) => typeof x === 'string');
      if (typeof v === 'string') return v.trim();
    } catch {
      // no era JSON válido; sigue con la limpieza de restos
    }
  }
  // Restos pegados al final: ...texto"}  ...texto"]}  ...texto }
  t = t.replace(/\s*["'`]?\s*[}\]]+\s*$/, '').trim();
  // Comillas envolventes sobrantes.
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('“') && t.endsWith('”'))) {
    t = t.slice(1, -1).trim();
  }
  return t || '...';
}

/** Parsea el JSON con reflexiones, metas y deseos; tolera fallos. */
function parseReflectionUpdate(raw: string): {
  reflexiones: string[];
  metas: string[];
  deseos: string[];
  ajustes: string[];
  experiencias: string[];
} {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]) as {
        reflexiones?: unknown;
        metas?: unknown;
        deseos?: unknown;
        ajustes?: unknown;
        experiencias?: unknown;
      };
      return {
        reflexiones: stringArray(obj.reflexiones).slice(0, 6),
        metas: stringArray(obj.metas).slice(0, 3),
        deseos: stringArray(obj.deseos).slice(0, 6),
        ajustes: stringArray(obj.ajustes).slice(0, 8),
        experiencias: stringArray(obj.experiencias).slice(0, 4),
      };
    }
  } catch {
    // cae al fallback
  }
  return { reflexiones: parseReflections(raw, 6), metas: [], deseos: [], ajustes: [], experiencias: [] };
}

/**
 * Si una opinión menciona a UNA sola persona conocida, devuelve su authorId
 * (para etiquetar la reflexión con su "sujeto"). Si menciona a varias o a
 * nadie, devuelve undefined (queda como opinión general).
 */
function subjectOf(idea: string, people: Array<{ authorId: string; authorName: string }>): string | undefined {
  const text = idea.toLowerCase();
  const hits = people.filter((p) => {
    const name = p.authorName.trim().toLowerCase();
    return name.length >= 3 && new RegExp(`\\b${escapeRegex(name)}\\b`).test(text);
  });
  return hits.length === 1 ? hits[0].authorId : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ¿Dos textos cuentan básicamente lo mismo? (dedup de experiencias). */
function textOverlap(a: string, b: string): boolean {
  const words = (s: string) =>
    new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return inter / union > 0.5; // >50% de palabras significativas en común
}

function stringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// --- Helpers de tiempo (sentido del tiempo) ---
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function dayName(d: Date): string {
  return DIAS[d.getDay()];
}
function dayPart(d: Date): string {
  const h = d.getHours();
  if (h < 6) return 'madrugada';
  if (h < 12) return 'mañana';
  if (h < 19) return 'tarde';
  return 'noche';
}
function clock(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function humanGap(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? '1 hora' : `${h} horas`;
  const days = Math.round(h / 24);
  return days === 1 ? '1 día' : `${days} días`;
}

/**
 * Tiempo relativo DIFUSO para etiquetar un recuerdo ("hace un rato", "hace unos
 * días", "hace años"). Vago a propósito: así Samara ubica un recuerdo en el
 * tiempo y habla de él natural, sin recitar fechas exactas (que ella misma no
 * "ve" pegadas al recuerdo). createdAt en ms epoch.
 */
function agoFuzzy(createdAt: number, now = Date.now()): string {
  const ms = now - createdAt;
  if (ms < 0) return 'hace nada';
  const min = ms / 60000;
  if (min < 2) return 'hace un momento';
  if (min < 60) return 'hace un rato';
  const h = min / 60;
  if (h < 6) return 'hace unas horas';
  if (h < 24) return 'hoy mismo';
  const d = h / 24;
  if (d < 2) return 'ayer';
  if (d < 7) return 'hace unos días';
  if (d < 14) return 'hace cosa de una semana';
  if (d < 31) return 'hace un par de semanas';
  const months = d / 30;
  if (months < 2) return 'hace como un mes';
  if (months < 11) return `hace unos ${Math.round(months)} meses`;
  const years = d / 365;
  if (years < 1.5) return 'hace como un año';
  if (years < 2.5) return 'hace un par de años';
  return `hace ${Math.round(years)} años`;
}

/** Parsea las reflexiones; acepta JSON o, si falla, líneas sueltas. */
function parseReflections(raw: string, max = 4): string[] {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]) as { reflexiones?: unknown };
      if (Array.isArray(obj.reflexiones)) {
        return obj.reflexiones
          .filter((x): x is string => typeof x === 'string')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
          .slice(0, max);
      }
    }
  } catch {
    // cae al fallback
  }
  // Fallback: líneas no vacías, sin viñetas.
  return raw
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l.length > 0)
    .slice(0, max);
}

/** La búsqueda vectorial puede fallar si la tabla está vacía; degradamos a []. */
function safeRecall(
  memory: MemoryStore,
  embedding: number[],
  k: number,
  ctx: RecallContext = {}
): RetrievedMemory[] {
  try {
    return memory.recall(embedding, k, ctx);
  } catch {
    return [];
  }
}
