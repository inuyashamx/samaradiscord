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

    const authorName = msg.member?.displayName ?? msg.author.username;
    const perception: Perception = {
      channelId: msg.channelId,
      authorId: msg.author.id,
      authorName,
      content: msg.content,
      isDev: this.isDev(msg.author.id, authorName, msg.author.username),
    };

    // Historial crudo: registra TODO lo que se dice (sustrato completo).
    this.history.log(perception.channelId, { ...perception, isSamara: false });

    // "Directo" = hablándole a ella: la etiquetan o responden a un mensaje suyo.
    // En ese caso debe contestar rápido, como en una conversación normal.
    const mentioned =
      this.client.user != null && msg.mentions.has(this.client.user);
    const replyingToHer =
      this.client.user != null &&
      msg.mentions.repliedUser?.id === this.client.user.id;
    const explicitlyDirect = mentioned || replyingToHer;

    // Si la etiquetan o responden a un mensaje suyo, es directo y seguro.
    // Si no, la mente decide: responder / esperar / ignorar, y de paso si el
    // mensaje le hablaba a ella (aunque sin etiquetar) para contestar ágil.
    let direct = explicitlyDirect;
    if (!explicitlyDirect) {
      const decision = await this.mind.decideTurn(perception);
      if (!decision.respond) {
        this.mind.observe(perception); // contexto inmediato (memoria de trabajo)
        // Aunque no conteste, recuerda lo que se dijo (estuvo presente leyendo).
        void this.mind
          .remember(perception)
          .catch((err) => console.error('Error guardando recuerdo:', err));
        this.armIdle(msg); // por si la conversación se queda muerta
        return;
      }
      direct = decision.directed;
    }

    try {
      const reply = await this.mind.respondTo(perception);
      await this.typeLikeAHuman(msg, reply, direct);
      await msg.reply(reply);
      this.logSamara(perception.channelId, reply);
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
      if ('send' in msg.channel) await msg.channel.send(text);
      this.logSamara(msg.channelId, text);
    } catch (err) {
      console.error('Error en mensaje proactivo:', err);
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
