import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from 'discord.js';
import { config } from '../config.js';
import type { Mind, Perception } from '../mind/mind.js';
import type { ChatHistory } from '../mind/history.js';

/** Quita los saltos de línea (todo en una sola línea). */
function cleanText(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

/**
 * Reemplaza las menciones crudas de Discord (<@id>, <@&id>, <#id>) por nombres
 * legibles. Sin esto, el modelo ve IDs numéricos, se confunde sobre quién es
 * quién y puede acabar respondiendo como si fuera otra persona.
 */
function resolveMentions(msg: Message): string {
  let content = msg.content;
  // Usuarios: <@id> o <@!id>
  content = content.replace(/<@!?(\d+)>/g, (_m, id: string) => {
    const name = msg.mentions.members?.get(id)?.displayName ?? msg.mentions.users.get(id)?.username;
    return name ? `@${name}` : '@alguien';
  });
  // Roles: <@&id>
  content = content.replace(/<@&(\d+)>/g, (_m, id: string) => {
    const role = msg.guild?.roles.cache.get(id);
    return role ? `@${role.name}` : '@rol';
  });
  // Canales: <#id>
  content = content.replace(/<#(\d+)>/g, (_m, id: string) => {
    const ch = msg.guild?.channels.cache.get(id);
    return ch ? `#${ch.name}` : '#canal';
  });
  return content;
}

/**
 * Estilo "chat real": el modelo escribe con ortografía perfecta por más que se
 * le pida lo contrario, así que normalizamos el texto. Minúsculas, sin acentos
 * (conservando la ñ), sin puntos finales ni "...", sin signos de apertura ¿¡.
 */
function casualize(text: string): string {
  let t = cleanText(text).toLowerCase();
  t = t.replace(/[¿¡]/g, '');
  // quita acentos (tilde aguda y diéresis); conserva la ñ (lleva otra tilde)
  t = t.normalize('NFD').replace(/[́̈]/g, '').normalize('NFC');
  t = t.replace(/\.{2,}/g, ' ').replace(/\.(?=\s|$)/g, ''); // "..." y puntos finales
  return t.replace(/\s{2,}/g, ' ').trim();
}

/** Aplica el estilo configurado al texto que se va a enviar. */
function styleOutput(text: string): string {
  return config.behavior.casualStyle ? casualize(text) : cleanText(text);
}

/**
 * El CUERPO en Discord. Traduce eventos de Discord -> percepciones para la
 * Mente, y respuestas de la Mente -> mensajes de Discord. No tiene lógica de
 * personalidad: es puramente entrada/salida.
 */
export class DiscordBody {
  private client: Client;
  /** Temporizador de inactividad por canal (para iniciativa propia). */
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private mind: Mind,
    private history: ChatHistory
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // hay que activarlo en el Developer Portal
      ],
      partials: [Partials.Channel],
    });
  }

  async start(): Promise<void> {
    this.client.once(Events.ClientReady, (c) => {
      console.log(`✅ Samara está en línea como ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, (msg) => this.onMessage(msg));

    await this.client.login(config.discord.token);
  }

  private async onMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return; // ignora a otros bots y a sí misma
    if (!msg.content) return;

    // Llegó actividad: cancela cualquier "romper silencio" pendiente. Al final
    // se rearmará, así el temporizador solo dispara cuando el canal queda quieto.
    this.cancelIdle(msg.channelId);

    // ¿A quién responde este mensaje? (función "responder" de Discord)
    const botId = this.client.user?.id;
    const repliedUser = msg.mentions.repliedUser ?? undefined;
    const replyingToHer = repliedUser != null && repliedUser.id === botId;
    const replyToOther =
      repliedUser != null && !replyingToHer
        ? msg.mentions.members?.get(repliedUser.id)?.displayName ?? repliedUser.username
        : undefined;

    const authorName = msg.member?.displayName ?? msg.author.username;
    const perception: Perception = {
      channelId: msg.channelId,
      authorId: msg.author.id,
      authorName,
      content: resolveMentions(msg), // <@id> -> @Nombre (si no, el modelo se confunde)
      isDev: this.isDev(msg.author.id, authorName, msg.author.username),
      replyTo: replyToOther, // si le responde a otra persona, no a Samara
    };

    // Historial crudo: registra TODO lo que se dice (sustrato completo).
    this.history.log(perception.channelId, { ...perception, isSamara: false });

    // "Directo" = hablándole a ella: la etiquetan o responden a un mensaje suyo.
    // En ese caso debe contestar rápido, como en una conversación normal.
    const mentioned =
      this.client.user != null && msg.mentions.has(this.client.user);
    const explicitlyDirect = mentioned || replyingToHer;

    // Ruido trivial (1-2 caracteres): no vale invocar al modelo, solo lo observa.
    if (!explicitlyDirect && msg.content.trim().length < 3) {
      this.mind.observe(perception);
      void this.mind.remember(perception).catch(() => {});
      this.armIdle(msg);
      return;
    }

    try {
      // Si la etiquetan/responden, contesta. Si no, ELLA decide si entra o se
      // queda callada (allowSilence): no hay un clasificador externo decidiendo.
      const reply = await this.mind.respondTo(perception, { allowSilence: !explicitlyDirect });
      if (reply) {
        await this.typeLikeAHuman(msg, reply, explicitlyDirect);
        await this.deliver(msg, reply);
        this.logSamara(perception.channelId, reply);
      }
      // Si reply es null, se quedó callada (ya recordó lo que vio).
    } catch (err) {
      console.error('Error generando respuesta:', err);
    } finally {
      this.armIdle(msg);
    }
  }

  /** Programa un posible mensaje espontáneo si el canal queda en silencio. */
  private armIdle(msg: Message): void {
    const { proactiveIdleMinSec: min, proactiveIdleMaxSec: max } = config.behavior;
    if (max <= 0) return; // proactividad desactivada

    const channelId = msg.channelId;
    this.cancelIdle(channelId);
    const seconds = min + Math.random() * Math.max(0, max - min);
    const timer = setTimeout(() => {
      void this.onIdle(msg);
    }, seconds * 1000);
    this.idleTimers.set(channelId, timer);
  }

  private cancelIdle(channelId: string): void {
    const timer = this.idleTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(channelId);
    }
  }

  /** Se dispara cuando un canal lleva un rato en silencio. */
  private async onIdle(msg: Message): Promise<void> {
    this.idleTimers.delete(msg.channelId);
    try {
      const text = await this.mind.proactiveTurn(msg.channelId);
      if (!text) return; // decidió quedarse callada
      if ('sendTyping' in msg.channel) await msg.channel.sendTyping();
      await new Promise((r) => setTimeout(r, Math.min(text.length * 30, 3500)));
      const clean = styleOutput(text);
      if ('send' in msg.channel) await msg.channel.send(clean);
      this.logSamara(msg.channelId, clean);
    } catch (err) {
      console.error('Error en mensaje proactivo:', err);
    }
  }

  /**
   * Envía la respuesta. Por defecto escribe normal (todos saben a quién le
   * habla); solo usa el "responder" citando cuando ya entraron otros mensajes
   * después, para que no quede ambiguo a qué contesta.
   */
  private async deliver(msg: Message, text: string): Promise<void> {
    const clean = styleOutput(text);
    const movedOn = msg.channel.lastMessageId !== msg.id; // entró algo después
    if (movedOn) {
      await msg.reply(clean); // cita para desambiguar
    } else if ('send' in msg.channel) {
      await msg.channel.send(clean); // mensaje normal
    } else {
      await msg.reply(clean);
    }
  }

  /** ¿Quien habla es el desarrollador? Por ID numérico o por nombre/usuario. */
  private isDev(authorId: string, displayName: string, username: string): boolean {
    const { devUserId, devUserName } = config.discord;
    if (devUserId && authorId === devUserId) return true;
    if (devUserName) {
      const want = devUserName.toLowerCase();
      if (displayName.toLowerCase() === want || username.toLowerCase() === want) return true;
    }
    return false;
  }

  /** Registra en el historial un mensaje propio de Samara. */
  private logSamara(channelId: string, content: string): void {
    const name = this.client.user?.username ?? 'Samara';
    this.history.log(channelId, {
      authorId: this.client.user?.id ?? 'samara',
      authorName: name,
      content,
      isSamara: true,
    });
  }

  /**
   * Muestra "escribiendo..." antes de enviar.
   * - Directo (le hablan a ella): pausa mínima, contesta ágil.
   * - Ambiental (se mete sola): pausa proporcional al largo, se siente humano.
   */
  private async typeLikeAHuman(
    msg: Message,
    reply: string,
    direct: boolean
  ): Promise<void> {
    if ('sendTyping' in msg.channel) await msg.channel.sendTyping();
    const delay = direct
      ? Math.min(reply.length * 10, 800)
      : Math.min(Math.max(reply.length * 30, 700), 3500);
    await new Promise((r) => setTimeout(r, delay));
  }
}
