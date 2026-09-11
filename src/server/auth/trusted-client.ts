import "server-only";

import { env } from "@/lib/env";
import { verifyTrustedRequest } from "@/server/ingress";

/** Only the Node ingress can produce this request-bound transport proof. */
export function trustedClientAddress(request: Request): string {
  return verifyTrustedRequest(request, env.AUTH_SECRET);
}
