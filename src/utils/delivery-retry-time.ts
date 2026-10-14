import { hostEnv } from "../env/host-env";

export function deliveryRetryTime(retryAt: number | undefined, now = hostEnv().clock.now()): string {
  if (retryAt === undefined) return "no automatic retry";
  if (retryAt <= now) return "retry due now";
  return `retry in ${Math.ceil((retryAt - now) / 1000)} s`;
}
