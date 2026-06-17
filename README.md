# Samara

**Una IA con personalidad, memoria, emociones y opiniones propias, conectada a Discord como una más del grupo.**

Samara es la protagonista del videojuego [XPELLIT](https://www.xpellit.com). Este
proyecto no es un chatbot: es un **agente con estado interno persistente** que
se comporta como una persona — recuerda, siente, se relaciona, opina y toma la
iniciativa. La meta a largo plazo es llevar este mismo "cerebro" a **NPCs con IA
que viven e interactúan en un mundo 3D**; Discord es el primer cuerpo.

---

## Idea central

Un chatbot responde y olvida. Samara tiene un **estado que persiste y evoluciona**:
percibe lo que pasa, lo recuerda, le afecta el ánimo, ajusta lo que siente por
cada persona, saca conclusiones propias y decide por su cuenta cuándo hablar.

La pieza clave de diseño es la separación **Cuerpo ↔ Mente**:

- **Cuerpo**: la entrada/salida. Hoy es Discord; mañana será el cliente del juego 3D.
- **Mente**: el núcleo reutilizable (personalidad, memoria, emociones, relaciones…).

Cambiar de Discord a un mundo 3D significa cambiar **solo el cuerpo**. El cerebro
no se reescribe. Además, el cuerpo le dice a la mente **dónde está**, y ella se
enmarca distinto: en Discord es consciente de que habla con la comunidad real y
está relajada; en el juego está inmersa en su lore, en personaje.

---

## Arquitectura

```
src/
  body/
    discord.ts        El cuerpo en Discord: eventos <-> percepciones/acciones
  mind/
    mind.ts           La mente: orquesta percepción, decisión y respuesta
    persona.ts        Identidad FIJA de Samara (su "character card") + contexto
    llm.ts            Interfaz LLMProvider + implementación OpenAI (intercambiable)
    db.ts             Conexión SQLite compartida
    short-term-memory.ts   Memoria de trabajo (últimos N mensajes por canal)
    memory.ts         Memoria de largo plazo (embeddings + sqlite-vec)
    relationships.ts  Afinidad y familiaridad por persona (persistente)
    emotion.ts        Estado de ánimo (valencia/energía, decae con el tiempo)
  scripts/
    chat.ts           Chat local en la terminal (probar sin Discord)
  config.ts           Configuración desde .env
  index.ts            Arranque del bot
```

### Cuerpo ↔ Mente

La `Mind` no sabe nada de Discord: recibe una `Perception` (qué se dijo, quién,
en qué canal) y decide qué hacer. Por eso el mismo núcleo servirá para el juego
3D, alimentado por percepciones espaciales en vez de mensajes de chat.

---

## Cómo funciona (los sistemas)

### 🧠 Memoria en capas

1. **Memoria de trabajo** (`short-term-memory.ts`): los últimos N mensajes por
   canal, en crudo. Lo que "tiene en mente" ahora mismo. Persistente: tras un
   reinicio retoma el hilo exacto de la conversación.
2. **Memoria de largo plazo** (`memory.ts`): cada mensaje significativo se guarda
   con su *embedding* en una base vectorial (SQLite + `sqlite-vec`). Al responder,
   recupera por **similitud semántica** los recuerdos más relevantes al tema y los
   mete en su prompt. Así recuerda cosas de hace días, no solo lo último.

### 💬 Participación orgánica

No responde a todo. Ante un mensaje que no la etiqueta, un modelo pequeño y barato
decide entre **responder / esperar / ignorar**, mirando el contexto:

- Si la **etiquetan**, **responden a un mensaje suyo** o **dicen su nombre** → responde (y rápido).
- Detecta cuándo le hablan **implícitamente** (p.ej. si en el chat solo están ella
  y otra persona, casi todo va dirigido a ella).
- En grupo no comenta cada mensaje, pero se mete cuando el tema le interesa.
- **Anti-cadena**: no responde en bucle justo después de hablar.
- **Velocidad contextual**: ágil si le hablan directo; "escribe" con pausa humana si se mete sola.

### 🗣️ Iniciativa propia

Si un canal queda en silencio un rato (tiempo **al azar** para que sea esporádico),
Samara *considera* romper el silencio o hacerle plática a quien quedó sin respuesta
— a veces sí, a veces no. No insiste si fue ella la última en hablar.

### ❤️ Emociones y relaciones

- **Ánimo** (`emotion.ts`): valencia (bien/mal) y energía, que **decaen hacia
  neutral** con el tiempo. Tiñe su tono. Persistente: al reiniciar retoma el
  ánimo que tenía (con el decaimiento del tiempo que estuvo apagada).
- **Relaciones** (`relationships.ts`): por cada persona guarda **afinidad** y
  **familiaridad**. Trata distinto a un desconocido que a un amigo → de ahí salen
  sus amistades. Es persistente entre sesiones.
- **Apreciación**: tras cada interacción evalúa (en segundo plano) cómo la hizo
  sentir el mensaje y ajusta ánimo y afinidad.

### 💭 Reflexión → opiniones propias

Cada cierto número de interacciones, "repasa" lo vivido y saca **conclusiones
propias** sobre la gente y los temas ("creo que Paul es buena onda pero
discutidor"). Las guarda como recuerdos especiales que **afloran** cuando habla.
Es lo que le da criterio propio emergente, no guionizado.

### 🎭 Personalidad

`persona.ts` define su identidad **fija**, basada en el canon de XPELLIT: una
*Elegida* amnésica (guerrera caída del cielo) que maneja magia de sombras,
aventurera de Villa Esperanza. Carácter: valiente, de humor seco, reservada, con
fuerte sentido de la justicia, leal con los suyos. Sobre esa base fija, el ánimo
y las relaciones hacen que se sienta distinta según el momento y con quién habla.

---

## Puesta en marcha

### Requisitos

- Node.js 20+ (probado en 22)
- Una API key de [OpenAI](https://platform.openai.com/api-keys)
- (Para Discord) un bot en el [Discord Developer Portal](https://discord.com/developers/applications)

### Instalación

```bash
npm install
cp .env.example .env   # y rellena tus claves
```

### Probar rápido sin Discord (chat en la terminal)

Solo necesitas `OPENAI_API_KEY`:

```bash
npm run chat
```

Habla con Samara directamente. Usa la **misma mente** que el bot, así que lo que
pruebes aquí es lo que verás en Discord. Comandos: `/reflexionar` (la hace pensar
y muestra sus conclusiones), `/salir`.

### Conectar a Discord

1. En el [Developer Portal](https://discord.com/developers/applications), abre tu
   app → **Bot** → *Reset Token* y copia el token.
2. Activa **MESSAGE CONTENT INTENT** (Bot → Privileged Gateway Intents). **Obligatorio.**
3. **OAuth2 → URL Generator**: marca `bot`, permisos *Send Messages* y
   *Read Message History*, abre la URL e invita el bot a tu servidor.
4. Copia el **Application ID** (General Information).
5. Rellena `DISCORD_TOKEN` y `DISCORD_APP_ID` en `.env`.

```bash
npm run dev    # desarrollo con recarga
# o
npm start
```

---

## Configuración (`.env`)

| Variable | Qué hace |
|---|---|
| `DISCORD_TOKEN` | Token del bot |
| `DISCORD_APP_ID` | Application ID |
| `DISCORD_GUILD_ID` | (Opcional) limita a un servidor |
| `OPENAI_API_KEY` | Tu clave de OpenAI |
| `OPENAI_MODEL` | Modelo del "cerebro" (def. `gpt-4o`) |
| `OPENAI_DECISION_MODEL` | Modelo barato para decisiones (def. `gpt-4o-mini`) |
| `OPENAI_EMBEDDING_MODEL` | Embeddings de memoria (def. `text-embedding-3-small`) |
| `SHORT_TERM_WINDOW` | Mensajes recientes en memoria de trabajo |
| `AMBIENT_MIN_GAP` | Anti-cadena: mensajes a esperar tras hablar |
| `PROACTIVE_IDLE_MIN_SEC` / `MAX_SEC` | Ventana de silencio para iniciativa propia (0 = off) |
| `REFLECTION_EVERY` | Cada cuántas interacciones reflexiona (0 = off) |

---

## Despliegue en un servidor (VM Debian/Ubuntu) con PM2

Para que Samara esté encendida 24/7. En la VM:

```bash
# 1. Node 20+ (vía NodeSource) y herramientas de compilación (better-sqlite3 es nativo)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs build-essential python3 git

# 2. Clonar e instalar
git clone https://github.com/inuyashamx/samaradiscord.git
cd samaradiscord
npm install

# 3. Crear el .env con tus claves (NO viene en el repo)
cp .env.example .env
nano .env

# 4. Arrancar con PM2
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 logs samara          # ver que arrancó bien

# 5. Que reviva sola al reiniciar la máquina
pm2 save
pm2 startup              # ejecuta el comando que imprime
```

Para actualizar tras cambios: `git pull && npm install && pm2 restart samara`.

> **Importante:** usa el script `start` (producción), no `dev` (watch). El archivo
> `data/samara.db` (toda la memoria/estado de Samara) vive en el disco de la VM y
> persiste entre reinicios automáticamente — haz copias de seguridad de ese archivo.

---

## Stack

- **Node.js + TypeScript** (ESM, `tsx`)
- **discord.js** v14
- **OpenAI** (chat, decisiones y embeddings) tras una interfaz `LLMProvider`
  intercambiable — para cambiar a otro proveedor/modelo basta con otra clase.
- **SQLite** (`better-sqlite3`) + **`sqlite-vec`** para memoria vectorial y estado persistente.

---

## Hoja de ruta

- [x] **Fase 0** — Bot en Discord con persona + memoria de trabajo
- [x] **Fase 1** — Memoria de largo plazo (embeddings + recuperación semántica)
- [x] **Fase 1.5** — Participación orgánica (responder/esperar/ignorar) + iniciativa propia
- [x] **Fase 2** — Estado de ánimo + relaciones por persona
- [x] **Fase 3** — Reflexión → opiniones propias emergentes
- [x] Consciencia de contexto (comunidad en Discord / lore en el juego)
- [ ] **Fase 4** — Proactividad avanzada (rutinas, ánimo del día)
- [ ] **Fase 5** — Abstracción del núcleo para un mundo 3D (NPCs con IA)

---

## Privacidad y costos

- Samara lee y guarda lo que se escribe en los canales donde está, en una base de
  datos local (`data/samara.db`, ignorada por git). Úsala en servidores donde eso
  sea aceptable.
- Cada mensaje implica llamadas a la API de OpenAI (chat + embeddings, y a veces una
  decisión barata). Mantén saldo en tu cuenta.

---

*Proyecto experimental. Samara y XPELLIT pertenecen a sus creadores.*
