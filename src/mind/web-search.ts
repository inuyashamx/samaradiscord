import { config } from '../config.js';

/**
 * Búsqueda en internet para Samara. Tres backends, en orden de preferencia:
 *   1. Tavily   (si hay TAVILY_API_KEY)  — pensado para IA, da hasta una respuesta directa
 *   2. Brave    (si hay BRAVE_API_KEY)   — buscador web general, resultados limpios
 *   3. DuckDuckGo (sin key)              — funciona sin configurar nada, PERO si se
 *      usa mucho seguido DuckDuckGo bloquea el tráfico automatizado (devuelve vacío).
 *
 * Para uso real conviene una key gratis (Tavily/Brave): es fiable. Sin key
 * funciona igual, solo que a ratos DuckDuckGo no devuelve resultados.
 *
 * La mente solo llama a webSearchText(); cambiar de backend no la toca.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const TIMEOUT_MS = 8000;

export interface WebResult {
  title: string;
  snippet: string;
  url: string;
}

/** Texto compacto de resultados para inyectar como resultado de la herramienta. */
export async function webSearchText(query: string, maxResults = 5): Promise<string> {
  const q = query.trim();
  if (!q) return 'no me diste qué buscar';
  let results: WebResult[];
  try {
    results = await webSearch(q, maxResults);
  } catch {
    return 'no pude conectarme a internet ahora mismo';
  }
  if (results.length === 0) return 'no encontré nada claro sobre eso en internet';
  return results
    .map((r) => (r.url ? `${r.title}\n${r.snippet}\n${r.url}` : `${r.title}: ${r.snippet}`))
    .join('\n\n');
}

/** Resultados crudos (elige backend según las keys disponibles). */
export async function webSearch(query: string, maxResults = 5): Promise<WebResult[]> {
  if (config.search.tavilyKey) return tavily(query, maxResults, config.search.tavilyKey);
  if (config.search.braveKey) return brave(query, maxResults, config.search.braveKey);
  return duckduckgo(query, maxResults);
}

/** fetch con timeout (para que una búsqueda colgada no congele su respuesta). */
async function fetchTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Tavily (API para IA) ---
async function tavily(query: string, max: number, key: string): Promise<WebResult[]> {
  const res = await fetchTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: 'basic' }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { answer?: string; results?: Array<{ title?: string; content?: string; url?: string }> };
  const out: WebResult[] = [];
  if (data.answer) out.push({ title: 'En resumen', snippet: stripHtml(data.answer), url: '' });
  for (const r of data.results ?? []) {
    out.push({ title: stripHtml(r.title ?? ''), snippet: stripHtml(r.content ?? ''), url: r.url ?? '' });
  }
  return out.slice(0, max + 1);
}

// --- Brave Search ---
async function brave(query: string, max: number, key: string): Promise<WebResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}`;
  const res = await fetchTimeout(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': key },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { web?: { results?: Array<{ title?: string; description?: string; url?: string }> } };
  return (data.web?.results ?? [])
    .slice(0, max)
    .map((r) => ({ title: stripHtml(r.title ?? ''), snippet: stripHtml(r.description ?? ''), url: r.url ?? '' }));
}

// --- DuckDuckGo (sin key, respaldo) ---
async function duckduckgo(query: string, max: number): Promise<WebResult[]> {
  const res = await fetchTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA },
  });
  // 202 = página "anomaly"; cualquier no-200 lo tratamos como sin resultados.
  if (res.status !== 200) return [];
  return parseDuckDuckGo(await res.text(), max);
}

/** Extrae título, resumen y enlace de la página de resultados de DuckDuckGo. */
function parseDuckDuckGo(html: string, max: number): WebResult[] {
  const links: Array<{ title: string; url: string }> = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) && links.length < max) {
    let url = lm[1];
    // DuckDuckGo envuelve el enlace real en ?uddg=<url-encoded>.
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    links.push({ title: stripHtml(lm[2]), url });
  }

  const snippets: string[] = [];
  const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let sm: RegExpExecArray | null;
  while ((sm = snipRe.exec(html))) snippets.push(stripHtml(sm[1]));

  return links.map((l, i) => ({ title: l.title, snippet: snippets[i] ?? '', url: l.url }));
}

/** Quita etiquetas HTML y descodifica las entidades más comunes. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
