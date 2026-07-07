module.exports = {
  apps: [
    {
      name: 'nexorder',
      script: 'server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        VERCEL: '0'
      }
    }
  ]
};
