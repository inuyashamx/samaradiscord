# Imagen moderna (Debian 12 dentro del contenedor), aislada del host.
# Resuelve el problema de GLIBC/Python viejos del servidor: aquí todo es nuevo.
FROM node:22-bookworm-slim

WORKDIR /app

# Por si algún módulo nativo (better-sqlite3) necesitara compilar.
# Normalmente baja un binario precompilado y ni se usa, pero va por seguridad.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Instala dependencias primero (mejor cacheo de capas).
COPY package*.json ./
RUN npm ci

# Copia el resto del código.
COPY . .

# Arranca el bot (producción).
CMD ["npm", "start"]
