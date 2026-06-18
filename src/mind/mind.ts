import { persona, type PresenceContext } from './persona.js';
import { config } from '../config.js';
import { ShortTermMemory, type Turn } from './short-term-memory.js';
import { MemoryStore, type RetrievedMemory } from './memory.js';
import { Relationships } from './relationships.js';
import { EmotionState } from './emotion.js';
import { ChatHistory } from './history.js';
import { Goals } from './goals.js';
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
}

export type TurnAction = 'responder' | 'esperar' | 'ignorar';

export interface TurnDecision {
  /** Si Samara debe contestar ahora. */
  respond: boolean;
  /** Si el mensaje le hablaba directamente a ella (aunque sin etiquetar). */
  directed: boolean;
  action: TurnAction;
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
  /** Interacciones acumuladas desde la última reflexión. */
  private interactionsSinceReflection = 0;
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
   * Decide qué hace Samara con un mensaje que NO la etiqueta. Como una persona
   * real que está en el chat, elige entre:
   *   - responder: le hablan a ella (aunque no la etiqueten) o quiere meterse.
   *   - esperar:   la cosa va hacia ella pero aún no es su turno; deja pasar.
   *   - ignorar:   no hablan con ella / no aporta nada.
   *
   * Clave: detecta cuando le hablan IMPLÍCITAMENTE. Si en el chat prácticamente
   * solo están ella y otra persona, casi todo va dirigido a ella.
   *
   * NO modifica la memoria (es solo una decisión).
   */
  async decideTurn(p: Perception): Promise<TurnDecision> {
    const text = p.content.trim();
    if (text.length < 2) return { respond: false, directed: false, action: 'ignorar' };

    // Si dicen su nombre (aunque no la etiqueten), claramente va con ella.
    if (/\bsamara\b/i.test(text)) {
      return { respond: true, directed: true, action: 'responder' };
    }

    const decision = await this.classifyTurn(p);

    // Anti-cadena: si NO le hablan directo y acaba de hablar, deja pasar el
    // turno aunque el tema le interese (evita monopolizar en grupo).
    if (
      decision.action === 'responder' &&
      !decision.directed &&
      this.turnsSinceSamaraSpoke(p.channelId) < config.behavior.ambientMinGap
    ) {
      return { respond: false, directed: false, action: 'esperar' };
    }

    return decision;
  }

  /** Un modelo chico clasifica el turno mirando el contexto y los participantes. */
  private async classifyTurn(p: Perception): Promise<TurnDecision> {
    const recent = this.stm.recent(p.channelId).slice(-10);
    const transcript = recent
      .map((t) => (t.isSamara ? `Samara: ${t.content}` : `${t.authorName}: ${t.content}`))
      .join('\n');

    // ¿Con quién está hablando? Si solo hay otra persona, casi todo es para ella.
    const others = new Set(recent.filter((t) => !t.isSamara).map((t) => t.authorName));
    others.add(p.authorName);
    const soloConEsta = others.size <= 1;

    // Con la gente que le cae bien tiende a engancharse más.
    const rel = this.relationships.get(p.authorId);
    const relNote = `Tu relación con ${p.authorName}: ${this.relationships.describe(rel)}`;

    // ¿Le está hablando a otra persona? Señal fuerte de que NO es para Samara.
    const dirigidoAOtro = p.replyTo
      ? `OJO: este mensaje le RESPONDE a ${p.replyTo}, no a ti. Casi seguro NO es para ti.`
      : '';

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Eres ${persona.name}, una persona en un chat de Discord. Decide qué harías con el ÚLTIMO mensaje, eligiendo una acción:
- "responder": te están hablando a TI (aunque no te etiqueten) o te dan ganas de meterte porque es natural/relevante.
- "esperar": la conversación va hacia ti pero todavía no es tu turno; mejor dejar pasar hasta ser relevante.
- "ignorar": no hablan contigo y no aportarías nada.

Reglas:
- Si en el chat prácticamente solo están tú y otra persona, casi todo lo que dice esa persona va dirigido a ti: normalmente "responder".
- Si le están hablando o preguntando a OTRA persona (no a ti), NO contestes tú, aunque el tema sea SOBRE ti: deja que esa persona responda. Eso es "ignorar". Ej: si alguien le pregunta a otro "donde vive samara?", no respondas tú, no es tu turno.
- En grupo no comentas cada mensaje, pero NO eres pasiva: si el tema te interesa de verdad y NO se lo están preguntando a alguien más, puedes meterte ("responder").
- Si de plano no te aporta ni va contigo, "ignorar" o "esperar".
- "dirigido" = true SOLO si el mensaje claramente te habla o te pregunta a TI.

Responde SOLO con JSON, sin texto extra:
{"dirigido": true|false, "accion": "responder"|"esperar"|"ignorar"}`,
      },
      {
        role: 'user',
        content: `${soloConEsta ? '(En este chat prácticamente solo están Samara y esta persona.)\n' : ''}${dirigidoAOtro ? dirigidoAOtro + '\n' : ''}${relNote}\n\nConversación reciente:\n${transcript || '(vacío)'}\n\nÚltimo mensaje:\n${p.authorName}: ${p.content}`,
      },
    ];

    const raw = await this.llm.chat(messages, {
      model: config.openai.decisionModel,
      temperature: 0.2,
      maxTokens: 30,
    });

    return parseDecision(raw);
  }

  /** Nº de mensajes de otros desde la última vez que habló Samara. */
  private turnsSinceSamaraSpoke(channelId: string): number {
    const recent = this.stm.recent(channelId);
    let n = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].isSamara) break;
      n++;
    }
    return n;
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
  async respondTo(p: Perception, opts: { allowSilence?: boolean } = {}): Promise<string | null> {
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
    const recalled = safeRecall(this.memory, contextEmbedding, RECALL_K);

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
    }

    const temporal = this.temporalNote(p.channelId, rel);
    const messages = this.buildPrompt(p.channelId, recalled, {
      state: `${temporal}\n${stateNote}`,
      instruction,
    });
    const reply = await this.generateReply(p.channelId, messages, opts.allowSilence);

    // Si decidió quedarse callada: igual recuerda lo que presenció (la vio
    // pasar, como una persona que lee), pero no responde ni la "aprecia".
    if (reply === null) {
      this.relationships.bump(p.authorId, p.authorName, 0);
      this.storeIfMemorable(p, embedding);
      return null;
    }

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

    // De vez en cuando, repasa lo vivido y saca conclusiones propias.
    this.interactionsSinceReflection++;
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
    try {
      const ideas = await this.reflect();
      if (ideas.length) console.log(`💭 Samara reflexionó (${ideas.length} ideas).`);
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

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `Eres ${persona.name}. Vas a repasar en silencio a tu gente, como una persona que piensa al final del día, y ACTUALIZAR dos cosas: tus opiniones y tus metas. Te doy lo de antes y lo que ha pasado hace poco. Reglas:
- OPINIONES: mantén las que siguen valiendo, CAMBIA o descarta las que ya no aplican (la gente cambia y tú también; no te aferres a una primera impresión), agrega nuevas si surgen.
- METAS: lo que TÚ quieres lograr ahora (1 a 3), en primera persona, concreto y con tu carácter (ej. "que dejen de probarme y me tomen en serio", "ganarme a fulano", "averiguar más de tal cosa"). Mantén las que sigan vivas, descarta las cumplidas o muertas, agrega nuevas según lo que vives. Que nazcan de lo que te mueve y de lo que pasa, no de la nada.
Todo breve, sin inventar. SOLO JSON:
{"reflexiones": ["...", "..."], "metas": ["...", "..."]}`,
      },
      {
        role: 'user',
        content: `Tus opiniones de antes:\n${priorText}\n\nTus metas de antes:\n${goalsText}\n\nLo que ha pasado hace poco:\n${material}`,
      },
    ];

    const raw = await this.llm.chat(messages, { temperature: 0.6, maxTokens: 500 });
    const { reflexiones: ideas, metas } = parseReflectionUpdate(raw);

    // Actualiza metas si sacó alguna (si no, conserva las de antes).
    if (metas.length > 0) this.goals.set(metas);

    if (ideas.length === 0) return []; // si no sacó opiniones, conserva las de antes

    // Reemplaza el set viejo por el revisado (sus opiniones quedan al día).
    this.memory.deleteReflections();
    for (const idea of ideas) {
      const embedding = await this.llm.embed(idea);
      this.memory.remember(
        {
          channelId: 'global',
          authorId: 'samara',
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
   * Genera la respuesta. Si el proveedor soporta herramientas, le ofrece buscar
   * en el historial del chat para cuando no esté segura de algo que se dijo.
   * Ella decide si la usa o no (function calling), como una persona que revisa
   * sus mensajes antes de afirmar algo.
   */
  private async generateReply(
    channelId: string,
    messages: ChatMessage[],
    allowSilence = false
  ): Promise<string | null> {
    if (!this.llm.chatWithTools) return sanitizeReply(await this.llm.chat(messages));

    const tools: ToolDef[] = [
      {
        name: 'buscar_en_historial',
        description:
          'Busca en el historial completo de este chat algo que se dijo antes. Úsalo SOLO si no estás segura de un dato y necesitas verificarlo antes de responder; no lo uses para todo.',
        parameters: {
          type: 'object',
          properties: {
            consulta: { type: 'string', description: 'Palabras clave a buscar (nombres, temas, etc.).' },
          },
          required: ['consulta'],
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
          'Busca en TU propia memoria (lo que has vivido y concluido) sobre un tema o una persona, para traerlo al frente cuando algo se sienta borroso. Es tu memoria ya procesada, distinta del historial crudo del chat.',
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
    const runTool: ToolRunner = async (name, args) => {
      switch (name) {
        case 'buscar_en_historial': {
          const found = this.history.search(channelId, String(args.consulta ?? ''), 8);
          return found.length === 0
            ? 'No encontré nada sobre eso en el historial.'
            : found.map((e) => `${e.authorName}: ${e.content}`).join('\n');
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
          const found = safeRecall(this.memory, emb, 10);
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
        case 'quedarme_callada':
          silent = true;
          return 'ok, te quedas callada';
        default:
          return 'herramienta desconocida';
      }
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
    let trato: string;
    if (familiarity === 0) {
      trato = `No conoces a ${name}. Sé cordial pero reservada, mídelo: la confianza se gana.`;
    } else if (affinity > 0.3) {
      trato = `${name} te cae bien. Trátalo con calidez y confianza AUNQUE estés de mal humor; tu enojo con otra gente NO se paga con quien aprecias.`;
    } else if (affinity < -0.3) {
      trato = `${name} no te cae bien, ha habido roces. Puedes ser cortante o seca con él.`;
    } else {
      trato = `Con ${name} tienes un trato normal, ni frío ni de gran confianza.`;
    }

    const lines = [
      `Tu humor general ahora: ${this.emotion.describe()}. Es un FONDO: tiñe tu ánimo, pero NO define cómo tratas a cada quien.`,
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
- valencia: qué tan bien (positivo) o mal (negativo) te hizo sentir.
- activacion: qué tanto te activó/energizó (0 = indiferente, 1 = mucho).
- afinidad: cuánto sube o baja lo que te cae esa persona con este mensaje.`,
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
  }

  private buildPrompt(
    channelId: string,
    recalled: RetrievedMemory[],
    notes: { state?: string; instruction?: string } = {}
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

    // Estado interno (ánimo + relación): le da color a su tono.
    if (notes.state) parts.push('', notes.state);

    if (recalled.length > 0) {
      parts.push(
        '',
        'Cosas que recuerdas de antes (úsalas solo si son relevantes, no las menciones forzado):'
      );
      for (const m of recalled) {
        // Las reflexiones son conclusiones suyas; los episodios, cosas que se dijeron.
        if (m.kind === 'reflection') {
          parts.push(`- (algo que piensas) ${m.content}`);
        } else {
          parts.push(`- ${m.authorName} dijo: "${m.content}"`);
        }
      }
    }

    if (notes.instruction) parts.push('', notes.instruction);

    const system = parts.join('\n');

    const history = this.stm.recent(channelId).map<ChatMessage>((t: Turn) => ({
      role: t.isSamara ? 'assistant' : 'user',
      content: t.isSamara ? t.content : `${t.authorName}: ${t.content}`,
    }));

    return [{ role: 'system', content: system }, ...history];
  }
}

/** Parsea el JSON de la decisión de turno; ante cualquier fallo, ignora. */
function parseDecision(raw: string): TurnDecision {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]) as { dirigido?: boolean; accion?: string };
      const action: TurnAction =
        obj.accion === 'responder' || obj.accion === 'esperar' || obj.accion === 'ignorar'
          ? obj.accion
          : 'ignorar';
      return { respond: action === 'responder', directed: obj.dirigido === true, action };
    }
  } catch {
    // cae al default
  }
  return { respond: false, directed: false, action: 'ignorar' };
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

/** Parsea el JSON con reflexiones y metas; tolera fallos. */
function parseReflectionUpdate(raw: string): { reflexiones: string[]; metas: string[] } {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]) as { reflexiones?: unknown; metas?: unknown };
      return {
        reflexiones: stringArray(obj.reflexiones).slice(0, 6),
        metas: stringArray(obj.metas).slice(0, 3),
      };
    }
  } catch {
    // cae al fallback
  }
  return { reflexiones: parseReflections(raw, 6), metas: [] };
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
  k: number
): RetrievedMemory[] {
  try {
    return memory.recall(embedding, k);
  } catch {
    return [];
  }
}
