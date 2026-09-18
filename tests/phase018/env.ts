/**
 * Phase018 fixture environment. This module must be imported before any server module so the
 * process client, Auth.js cookie codec and payload envelope all target the isolated database.
 * It carries no test-only auth bypass: every session below is a real AuthSession row.
 */
import fs from "node:fs";
import path from "node:path";

const file = process.env.PHASE018_FIXTURE_CONFIG;
if (file) {
  const data = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) as {
    appUrl: string;
    authSecret: string;
    encryptionKey: string;
  };
  process.env.DATABASE_URL = data.appUrl;
  process.env.AUTH_SECRET = data.authSecret;
  process.env.ENCRYPTION_KEY = data.encryptionKey;
  process.env.AUTH_URL = "http://127.0.0.1:3000";
  process.env.AUTH_TRUSTED_PROXY_CIDRS = "";
  process.env.AI_MOCK = "true";
  process.env.AI_TIMEOUT_MS = "60000";
  process.env.AI_DAILY_COST_LIMIT = "5";
}
