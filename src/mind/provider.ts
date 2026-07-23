import { config } from '../config.js';
import { OpenAIProvider, type LLMProvider } from './llm.js';
import { GeminiProvider } from './gemini.js';

/**
 * Crea el proveedor de lenguaje según LLM_PROVIDER (.env): 'gemini' o 'openai'.
 * El resto de la mente solo ve la interfaz LLMProvider, no sabe cuál es.
 */
export function createLLM(): LLMProvider {
  const provider = config.llmProvider === 'gemini' ? new GeminiProvider() : new OpenAIProvider();
  console.log(`🗣️  Cerebro: ${config.llmProvider}`);
  return provider;
}
