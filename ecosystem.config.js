// pm2 process file for the Covenza heartbeat bot (MAINNET-READINESS item 16).
//
//   npm install -g pm2
//   pm2 start ecosystem.config.js          start (and restart on crash)
//   pm2 logs covenza-heartbeat             follow the log
//   pm2 status                             is it running?
//   pm2 stop covenza-heartbeat             stop
//
// Secrets stay in .env, which the bot reads itself; nothing sensitive here.
module.exports = {
  apps: [
    {
      name: "covenza-heartbeat",
      script: "scripts/heartbeat-bot.js",
      env: { HEARTBEAT_NETWORK: "robinhoodTestnet" },
      env_mainnet: { HEARTBEAT_NETWORK: "robinhoodMainnet" },   // pm2 start ecosystem.config.js --env mainnet
      autorestart: true,
      // A bot that dies at start-up (bad RPC, no key) backs off from 10s
      // towards 15 minutes instead of restarting, and alerting, every 10s.
      exp_backoff_restart_delay: 10000,
      time: true,
    },
  ],
};
