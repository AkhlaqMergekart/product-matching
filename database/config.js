const path = require("path");
const { Sequelize } = require("sequelize");

// The shared `sellerpundit-live` Postgres, read for source catalog rows
// (ScratchProducts). See database/localConfig.js for the separate, local-only
// database that test results are written to — this one is READ-ONLY to this
// service, and the account it connects with reflects that.
//
// ---------------------------------------------------------------------------
// Credentials are NOT hardcoded here any more. They used to be — host, user
// and password were baked into this file — which is the one thing
// config/proxy.js explicitly refuses to do, for the reason given there: a
// password in git history is not something you can take back. They're read
// from, in order:
//   1. env vars    — DB_HOST / DB_PORT / DB_NAME / DB_USERNAME / DB_PASSWORD
//   2. config.json — DB_Host / DB_Port / DB_Name / DB_Username / DB_Password
//                    (gitignored, where SMTP_* / PROXY_* already live)
//
// Host, port, name and user carry defaults so a fresh checkout points at the
// right server; the PASSWORD has no default, exactly as with the proxy.
// ---------------------------------------------------------------------------
function loadFileConfig() {
  try {
    return require(path.join(__dirname, "..", "config.json"));
  } catch (err) {
    return {};
  }
}

const fileConfig = loadFileConfig();

const DB_HOST = process.env.DB_HOST || fileConfig.DB_Host || "82.25.105.38";
const DB_PORT = parseInt(process.env.DB_PORT || fileConfig.DB_Port || "5432", 10);
const DB_NAME = process.env.DB_NAME || fileConfig.DB_Name || "sellerpundit-live";
const DB_USERNAME = process.env.DB_USERNAME || fileConfig.DB_Username || "readonly_user";
const DB_PASSWORD = process.env.DB_PASSWORD || fileConfig.DB_Password || "";

if (!DB_PASSWORD) {
  console.error(
    "[database/config.js] No database password found. Set DB_PASSWORD in the environment, " +
      "or DB_Password in config.json. Every query will fail until this is set."
  );
}

const sequelize = new Sequelize(DB_NAME, DB_USERNAME, DB_PASSWORD, {
  host: DB_HOST,
  port: DB_PORT,
  dialect: "postgres",
  logging: false,
});

// NOTE: this is authenticate(), not sync(). sync() issues schema statements
// (CREATE TABLE IF NOT EXISTS for every model defined) against a SHARED
// production database, as a side effect of merely requiring this file. This
// service only ever reads from it — every ScratchProducts access is a findAll
// — so there is nothing for it to create, and the connection it now connects
// with (readonly_user) could not create it anyway.
sequelize
  .authenticate()
  .then(() => {
    console.log(`**********Postgres Connected successfully! (${DB_USERNAME}@${DB_HOST}:${DB_PORT}/${DB_NAME})**********`);
  })
  .catch((e) => {
    console.log(`**********Postgres Connection failed :(**********`);
    console.log(e.message);
  });

module.exports = { sequelize };
