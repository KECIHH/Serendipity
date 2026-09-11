import "@testing-library/jest-dom/vitest";

process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.AUTH_SECRET = "test-auth-secret-with-at-least-32-characters";
process.env.AUTH_URL = "http://localhost:3000";
process.env.AUTH_TRUSTED_PROXY_CIDRS = "";
process.env.ENCRYPTION_KEY = "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcyEhISE=";
process.env.AI_API_KEY = "";
process.env.AI_BASE_URL = "https://api.deepseek.com";
process.env.AI_MODEL = "deepseek-chat";
process.env.AI_MOCK = "true";
process.env.AI_TIMEOUT_MS = "60000";
process.env.AI_DAILY_COST_LIMIT = "5";
