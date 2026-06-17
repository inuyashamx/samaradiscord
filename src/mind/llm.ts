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

/**
 * Interfaz del proveedor de lenguaje. El resto de la "mente" depende SOLO de
 * esto, no de OpenAI directamente. Para cambiar a OpenRouter, Ollama o un
 * modelo menos restringido, basta con escribir otra clase que implemente
 * LLMProvider — nada más de la mente se entera.
 */
export interface LLMProvider {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
  embed(text: string): Promise<number[]>;
}

export class OpenAIProvider implements LLMProvider {
  private client = new OpenAI({ apiKey: config.openai.apiKey });

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const model = opts.model ?? config.openai.model;
    // Los modelos de razonamiento (o1/o3/gpt-5...) usan otros parámetros:
    // no aceptan temperatura, y "piensan" gastando tokens, así que necesitan
    // un presupuesto mínimo o devuelven vacío.
    const isReasoning = /^(o\d|gpt-5)/i.test(model);

    const params: Record<string, unknown> = { model, messages };
    if (isReasoning) {
      params.max_completion_tokens = Math.max(opts.maxTokens ?? 400, 512);
      params.reasoning_effort = 'low'; // rápido; suficiente para chatear/decidir
    } else {
      params.max_completion_tokens = opts.maxTokens ?? 400;
      params.temperature = opts.temperature ?? 0.75; // algo de variedad sin divagar
    }

    const res = await this.createWithFallback(params);
    return res.choices[0]?.message?.content?.trim() ?? '...';
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
