// pm2 processes for product matching. Each is the same app on its own port,
// so the Amazon India and Flipkart runs go to separate processes — separate
// logs, restarts and memory, and no shared proxy sessions:
//
//   pm2 start ecosystem.config.js            # start / add both
//   pm2 reload ecosystem.config.js           # after a deploy
//
// Any process accepts any destination; which one a run lands in is decided
// by the port the request is sent to. The original single process on 8010
// (pm2 name "index") is separate and can keep serving Nahdi / Mumzworld.
module.exports = {
  apps: [
    {
      name: "product-matching-amazon",
      script: "index.js",
      cwd: __dirname,
      env: { PORT: 8013 }, // not 8011: nginx listens there on the server
    },
    {
      name: "product-matching-flipkart",
      script: "index.js",
      cwd: __dirname,
      env: { PORT: 8012 },
    },
  ],
};
