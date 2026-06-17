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
    const res = await this.client.chat.completions.create({
      model: opts.model ?? config.openai.model,
      messages,
      temperature: opts.temperature ?? 0.75, // algo de variedad sin divagar
      max_tokens: opts.maxTokens ?? 400,
    });
    return res.choices[0]?.message?.content?.trim() ?? '...';
  }

  async embed(text: string): Promise<number[]> {
    const res = await this.client.embeddings.create({
      model: config.openai.embeddingModel,
      input: text,
    });
    return res.data[0].embedding;
  }
}
