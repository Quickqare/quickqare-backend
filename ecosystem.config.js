module.exports = {
  apps: [
    {
      name: "quickqare-backend",
      script: "index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 4000,
        // Calendar-day logic (cake lead times, baker daily caps) assumes IST;
        // bare VMs often run UTC.
        TZ: "Asia/Kolkata",
      },
    },
  ],
};
