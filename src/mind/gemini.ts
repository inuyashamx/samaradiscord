import { config } from '../config.js';
import type {
  LLMProvider,
  ChatMessage,
  ChatOptions,
  ContentPart,
  ToolDef,
  ToolRunner,
} from './llm.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Debe coincidir con EMBED_DIM de memory.ts (la tabla vectorial es float[1536]).
const EMBED_DIM = 1536;

/**
 * Proveedor de lenguaje con Google Gemini (mucho más barato que OpenAI). Habla
 * por REST, sin dependencias extra. Implementa la MISMA interfaz LLMProvider, así
 * que el resto de la mente no se entera de con quién habla.
 *
 * Ojo con los embeddings: Gemini vive en un ESPACIO vectorial distinto al de
 * OpenAI. Se piden a 1536 dims para que la tabla no se rompa, pero los recuerdos
 * viejos (embebidos con OpenAI) no serán comparables con los nuevos hasta
 * re-embeberlos (npm run reembed).
 */
export class GeminiProvider implements LLMProvider {
  private get key(): string {
    return config.gemini.apiKey;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const model = opts.model ?? config.gemini.model;
    const { system, contents } = await toGemini(messages);
    const body = {
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents,
      generationConfig: genConfig(opts),
    };
    const data = await this.post(`${model}:generateContent`, body);
    return extractText(data) || '...';
  }

  async chatWithTools(
    messages: ChatMessage[],
    tools: ToolDef[],
    runTool: ToolRunner,
    opts: ChatOptions = {}
  ): Promise<string> {
    const model = opts.model ?? config.gemini.model;
    const { system, contents } = await toGemini(messages);
    const functionDeclarations = tools.map((t) => {
      const params = cleanSchema(t.parameters);
      return { name: t.name, description: t.description, ...(params ? { parameters: params } : {}) };
    });

    const convo: unknown[] = [...contents];
    for (let i = 0; i < 3; i++) {
      const body = {
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: convo,
        tools: [{ functionDeclarations }],
        generationConfig: genConfig(opts),
      };
      const data = await this.post(`${model}:generateContent`, body);
      const parts: Array<Record<string, unknown>> = data?.candidates?.[0]?.content?.parts ?? [];
      const calls = parts
        .map((p) => p.functionCall as { name?: string; args?: Record<string, unknown> } | undefined)
        .filter((c): c is { name: string; args?: Record<string, unknown> } => !!c && !!c.name);

      // Sin llamadas => su texto final (puede ser "" si solo reaccionó/actuó y
      // no quiso escribir; el cuerpo trata "" como "no mandar nada").
      if (calls.length === 0) return extractText(data);

      // Turno del modelo (sus llamadas) + turno con los resultados.
      convo.push({ role: 'model', parts });
      const responseParts = [];
      for (const c of calls) {
        let result = 'sin resultado';
        try {
          result = await runTool(c.name, c.args ?? {});
        } catch {
          result = 'error al usar la herramienta';
        }
        responseParts.push({ functionResponse: { name: c.name, response: { result } } });
      }
      convo.push({ role: 'user', parts: responseParts });
    }
    // Si insistió demasiado, una respuesta final sin herramientas.
    return this.chat(messages, opts);
  }

  async embed(text: string): Promise<number[]> {
    const model = config.gemini.embeddingModel;
    const body = {
      model: `models/${model}`,
      content: { parts: [{ text }] },
      outputDimensionality: EMBED_DIM,
    };
    const data = await this.post(`${model}:embedContent`, body);
    const values: number[] = data?.embedding?.values ?? [];
    return normalize(values); // dims != 3072 no vienen normalizados; para vec search sí
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await fetch(`${BASE}/models/${path}?key=${encodeURIComponent(this.key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
    }
    return res.json();
  }
}

/**
 * Config de generación. Los modelos flash "-latest" PIENSAN (~500-600 tokens de
 * "thinking") y ese gasto se descuenta del tope de salida, así que sin holgura el
 * texto/JSON se trunca. Damos margen extra para que el thinking no se coma la
 * respuesta. Solo se cobra lo que de verdad se genera, así que el margen alto no
 * cuesta de más salvo que lo use.
 */
function genConfig(opts: ChatOptions): Record<string, unknown> {
  return {
    temperature: opts.temperature ?? 0.75,
    maxOutputTokens: (opts.maxTokens ?? 512) + 2048,
  };
}

/** Convierte nuestros ChatMessage al formato Gemini (system aparte; roles user/model). */
async function toGemini(
  messages: ChatMessage[]
): Promise<{ system: string; contents: Array<{ role: string; parts: unknown[] }> }> {
  let system = '';
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + contentToText(m.content);
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: await toParts(m.content) });
  }
  return { system, contents };
}

/** Partes de un mensaje: texto y, si hay, imágenes (descargadas e incrustadas). */
async function toParts(content: string | ContentPart[]): Promise<unknown[]> {
  if (typeof content === 'string') return [{ text: content }];
  const parts: unknown[] = [];
  for (const p of content) {
    if (p.type === 'text') parts.push({ text: p.text });
    else if (p.type === 'image_url') {
      const inline = await fetchInline(p.image_url.url);
      if (inline) parts.push({ inlineData: inline });
    }
  }
  return parts.length ? parts : [{ text: '' }];
}

/** Baja una imagen y la deja lista para Gemini (base64 inline). null si falla. */
async function fetchInline(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    const data = Buffer.from(await res.arrayBuffer()).toString('base64');
    return { mimeType, data };
  } catch {
    return null;
  }
}

/** Texto plano de un contenido (para el system prompt, que en Gemini es aparte). */
function contentToText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join(' ');
}

/** Extrae el texto de la respuesta de Gemini. */
function extractText(data: any): string {
  const parts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((p) => p.text)
    .filter((t): t is string => typeof t === 'string')
    .join('')
    .trim();
}

/**
 * Adapta un JSON Schema nuestro al de Gemini: pone los `type` en MAYÚSCULAS
 * (STRING/OBJECT/NUMBER...) y omite parámetros si la herramienta no tiene ninguno.
 */
function cleanSchema(schema: Record<string, unknown> | undefined): unknown {
  if (!schema || typeof schema !== 'object') return undefined;
  const props = schema.properties as Record<string, unknown> | undefined;
  if (schema.type === 'object' && (!props || Object.keys(props).length === 0)) return undefined;
  return upperTypes(schema);
}

function upperTypes(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(upperTypes);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x)) {
      out[k] = k === 'type' && typeof v === 'string' ? v.toUpperCase() : upperTypes(v);
    }
    return out;
  }
  return x;
}

/** Normaliza un vector a longitud 1 (para búsqueda vectorial estable). */
function normalize(v: number[]): number[] {
  let mag = 0;
  for (const x of v) mag += x * x;
  mag = Math.sqrt(mag);
  return mag > 0 ? v.map((x) => x / mag) : v;
}
