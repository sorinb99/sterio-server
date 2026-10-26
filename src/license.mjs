// Beta builds stop serving music on a date fixed when scripts/build.mjs makes
// them (90 days on), like a TestFlight build, so a beta image kept around
// can't be used for ever. The build writes the date into the code; running
// from src/ never expires unless STERIO_BETA_EXPIRES is set to try it.
import { HttpError } from './auth.mjs';
const raw = process.env.STERIO_BETA_EXPIRES;
export const betaExpires = raw ? new Date(raw) : null;
if (betaExpires && Number.isNaN(betaExpires.getTime())) throw new Error('Invalid beta expiry date');
export const betaExpiresDay = betaExpires?.toISOString().slice(0,10) ?? null;
export const betaExpired = () => Boolean(betaExpires) && Date.now() >= betaExpires.getTime();
export function requireActiveBeta() {
  if (betaExpired()) throw Object.assign(new HttpError(403,`This Sterio Server beta expired on ${betaExpiresDay}. Install the latest Sterio Server to keep listening.`),{code:'beta_expired'});
}
