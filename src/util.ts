// util.ts — deterministic trial clock, counters, time and base64 helpers.
//
// Every timestamp in the entry comes from here: MAKEFUN_TRIAL_NOW when the trial sets it,
// otherwise the scenario epoch 2025-01-01T00:00:00Z (SCENARIO_EPOCH_SEC = 1735689600).
// Nothing in this module reads the wall clock, so two runs on the same trial are identical.
//
// No `Date` is used anywhere: ISO-8601 formatting/parsing is done with plain integer
// arithmetic (Howard Hinnant's civil-date algorithms), so no wall-clock read
// appears anywhere in the entry.

/** The scenario's day one, 2025-01-01T00:00:00Z, in epoch seconds (wire.ts SCENARIO_EPOCH_SEC). */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

/** The scenario seed, as lowercase hex (wire.ts SCENARIO_SEED_HEX). */
export const SCENARIO_SEED_HEX = '6a09e667f3bcc909';

/** The trial's seed string: MAKEFUN_TRIAL_SEED when set, else the scenario seed hex. */
export function trialSeed(): string {
  const raw = process.env.MAKEFUN_TRIAL_SEED;
  return raw !== undefined && raw !== '' ? raw : SCENARIO_SEED_HEX;
}

/**
 * The trial's "now" in epoch seconds: MAKEFUN_TRIAL_NOW (an ISO-8601 string) when set and
 * parseable, otherwise the fixed scenario epoch. Never the wall clock.
 */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const sec = secFromIso(raw);
    if (sec !== null) return sec;
  }
  return SCENARIO_EPOCH_SEC;
}

/** The trial's "now" as an ISO-8601 string with milliseconds and a Z suffix. */
export function trialNowIso(): string {
  return isoFromSec(trialNowSec());
}

// ---------------------------------------------------------------------------
// Civil-date arithmetic (days since 1970-01-01 <-> year/month/day).

function civilFromDays(zIn: number): { y: number; m: number; d: number } {
  const z = zIn + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: m <= 2 ? y + 1 : y, m, d };
}

function daysFromCivil(yIn: number, m: number, d: number): number {
  const y = m <= 2 ? yIn - 1 : yIn;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  if (n < 10) return `000${n}`;
  if (n < 100) return `00${n}`;
  if (n < 1000) return `0${n}`;
  return String(n);
}

/** Format epoch seconds as `YYYY-MM-DDTHH:MM:SS.000Z` (UTC). */
export function isoFromSec(sec: number): string {
  const whole = Math.floor(sec);
  const days = Math.floor(whole / 86400);
  const rest = whole - days * 86400;
  const { y, m, d } = civilFromDays(days);
  const hh = Math.floor(rest / 3600);
  const mm = Math.floor((rest - hh * 3600) / 60);
  const ss = rest - hh * 3600 - mm * 60;
  return `${pad4(y)}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.000Z`;
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse an ISO-8601 timestamp to epoch seconds, or null when it does not parse.
 * Accepts a trailing Z or a numeric offset; a missing offset means UTC.
 */
export function secFromIso(iso: string): number | null {
  const match = ISO_RE.exec(iso);
  if (match === null) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  const hh = Number(match[4]);
  const mi = Number(match[5]);
  const ss = Number(match[6]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 60) return null;
  let sec = daysFromCivil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + ss;
  const zone = match[8];
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const zh = Number(digits.slice(0, 2));
    const zm = Number(digits.slice(2, 4));
    sec -= sign * (zh * 3600 + zm * 60);
  }
  return sec;
}

// ---------------------------------------------------------------------------
// Sequential counters (ids and request ids are monotonic, never random).

/** A simple monotonic counter starting at `start` (default 1). */
export class Counter {
  private nextValue: number;

  constructor(start = 1) {
    this.nextValue = start;
  }

  /** The next value, then advance. */
  next(): number {
    const value = this.nextValue;
    this.nextValue += 1;
    return value;
  }

  /** The value the next call to next() will return. */
  peek(): number {
    return this.nextValue;
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers (standard alphabet; node_id and contents both use it).

/** Standard base64 of a Buffer or UTF-8 string. */
export function b64encode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64');
}

/** Decode standard base64 (whitespace tolerated) to a Buffer. */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\s]/g, ''), 'base64');
}

/** URL-safe base64 without padding, of a Buffer or UTF-8 string. */
export function b64urlEncode(data: Buffer | string): string {
  return b64encode(data).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
