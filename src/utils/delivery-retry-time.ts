import { hostEnv } from "../env/host-env";

export function deliveryRetryTime(retryAt: number, now = hostEnv().clock.now()): string {
  return `retry in ${Math.max(0, Math.ceil((retryAt - now) / 1000))} s`;
}
