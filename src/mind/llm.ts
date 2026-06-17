import OpenAI from 'openai';
import { config } from '../config.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Una herramienta que el modelo puede decidir invocar. */
export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema de los argumentos. */
  parameters: Record<string, unknown>;
}

/** Ejecuta una herramienta llamada por el modelo y devuelve su resultado. */
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<string>;

/**
 * Interfaz del proveedor de lenguaje. El resto de la "mente" depende SOLO de
 * esto, no de OpenAI directamente. Para cambiar a OpenRouter, Ollama o un
 * modelo menos restringido, basta con escribir otra clase que implemente
 * LLMProvider — nada más de la mente se entera.
 */
export interface LLMProvider {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  embed(text: string): Promise<number[]>;
  /** Chat con herramientas que el modelo puede invocar (opcional). */
  chatWithTools?(
    messages: ChatMessage[],
    tools: ToolDef[],
    runTool: ToolRunner,
    opts?: ChatOptions
  ): Promise<string>;
}

export class OpenAIProvider implements LLMProvider {
  private client = new OpenAI({ apiKey: config.openai.apiKey });

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const params = { ...this.baseParams(opts), messages };
    const res = await this.createWithFallback(params);
    return res.choices[0]?.message?.content?.trim() ?? '...';
  }

  /**
   * Chat dándole herramientas al modelo. Si las invoca, las ejecutamos y le
   * devolvemos el resultado para que produzca su respuesta final. Hasta 3
   * vueltas (suficiente para una o dos consultas).
   */
  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    runTool: ToolRunner,
    opts: ChatOptions = {}
  ): Promise<string> {
    const oaiTools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    // Conversación mutable (acumula llamadas a herramientas y sus resultados).
    const convo: unknown[] = [...messages];

    for (let i = 0; i < 3; i++) {
      const params = { ...this.baseParams(opts), messages: convo, tools: oaiTools };
      const res = await this.createWithFallback(params);
      const m = res.choices[0]?.message;
      if (!m) return '...';

      const calls = m.tool_calls ?? [];
      if (calls.length === 0) return m.content?.trim() ?? '...';

      convo.push(m); // mensaje del asistente con las llamadas
      for (const c of calls) {
        const fn = (c as { function?: { name?: string; arguments?: string }; id?: string }).function;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(fn?.arguments || '{}');
        } catch {
          args = {};
        }
        let result = 'sin resultado';
        try {
          result = await runTool(fn?.name ?? '', args);
        } catch {
          result = 'error al usar la herramienta';
        }
        convo.push({ role: 'tool', tool_call_id: (c as { id?: string }).id, content: result });
      }
    }
    // Si insistió demasiado, una última respuesta sin herramientas.
    return this.chat(messages, opts);
  }

  /**
   * Parámetros base según la familia del modelo. Los de razonamiento
   * (o1/o3/gpt-5...) no aceptan temperatura y "piensan" gastando tokens, así
   * que necesitan un presupuesto mínimo o devuelven vacío.
   */
  private baseParams(opts: ChatOptions): Record<string, unknown> {
    const model = opts.model ?? config.openai.model;
    const isReasoning = /^(o\d|gpt-5)/i.test(model);
    const params: Record<string, unknown> = { model };
    if (isReasoning) {
      params.max_completion_tokens = Math.max(opts.maxTokens ?? 400, 512);
      params.reasoning_effort = 'low';
    } else {
      params.max_completion_tokens = opts.maxTokens ?? 400;
      params.temperature = opts.temperature ?? 0.75;
    }
    return params;
  }

  /** Si el modelo no acepta algún parámetro, lo quita y reintenta una vez. */
  private async createWithFallback(
    params: Record<string, unknown>
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    try {
      return await this.client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
      );
    } catch (err) {
      const e = err as { code?: string; param?: string };
      if (e?.code === 'unsupported_parameter' && e.param && e.param in params) {
        const { [e.param]: _omit, ...rest } = params;
        return await this.client.chat.completions.create(
          rest as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
        );
      }
      throw err;
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: config.openai.embeddingModel,
      input: text,
    });
    return res.data[0].embedding;
  }
}
