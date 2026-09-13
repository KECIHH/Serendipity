import path from "node:path";
import { runAdminCommand } from "../phase013/api-key-fixture";

/** Execute the real isolated bootstrap CLI in a fresh process with retired env keys absent. */
export function enableMockWorker(fixtureConfig: string) {
  return runAdminCommand(
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "src/server/ai/enable-mock-cli.ts",
      "--fixture-config",
      path.resolve(fixtureConfig),
    ],
    { env: { AI_API_KEY: undefined, AI_BASE_URL: undefined, AI_MODEL: undefined } },
  );
}
