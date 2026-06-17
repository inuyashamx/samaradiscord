// Configuración de PM2 para correr Samara en un servidor (VM Debian, etc.).
//   pm2 start ecosystem.config.cjs
//   pm2 logs samara        (ver salida)
//   pm2 restart samara     (reiniciar tras un git pull)
//   pm2 save && pm2 startup (que reviva sola al reiniciar la máquina)
module.exports = {
  apps: [
    {
      name: 'samara',
      script: 'npm',
      args: 'start', // usa "start" (producción), NO "dev" (watch)
      cwd: __dirname,
      autorestart: true,
      max_restarts: 10,
      // Si se cae en bucle muy rápido, espera antes de reintentar.
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
