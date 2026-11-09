export const INTERVAL = 10_000;
// A temporary owner-authorized slower pilot expires without another command.
export function targetInterval(state,now=Date.now()){
 const p=state?.intervalPilot;
 return state?.sourceMode==='cloud'&&p?.intervalMs===15000&&Number.isFinite(p.startedAt)&&Number.isFinite(p.endsAt)&&p.startedAt<=now&&p.endsAt>now&&p.endsAt-p.startedAt<=30*60000?15000:INTERVAL;
}
export const ERROR_RETRY_MS = 60_000;
export const STOCK_MAX_AGE_MS = 120_000;
export const PRICE_MAX_AGE_MS = 60_000;
export const WATCHDOG_MS = 90_000;
export const RECOVERY_INTERVAL_MS = 60_000;
export const MAX_RECOVERY_INTERVAL_MS = 300_000;
export const SPEED_RECOVERY_MS = 60*60*1000;
export const NATIVE_MAX_AGE_MS = 20_000;
export const NATIVE_FETCH_BUDGET_MS = 8_000;
export const CLOUD_POLICY_VERSION=3;
export const CLOUD_REJECT_BASE_MS=60_000;
export const CLOUD_REJECT_MAX_MS=300_000;
export const CLOUD_MAX_AGE_MS=20_000;
export const CLOUD_FETCH_BUDGET_MS=8_000;
