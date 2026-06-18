import type { CanonicalEvent, DataQualityFlag } from "../../types";

// Shift window starts at 23:00 local and runs to 07:00. A single shift spans
// two calendar dates; we label it by the date the 23:00 start falls on.
const SHIFT_START_HOUR = 23;
const SHIFT_END_HOUR = 7;

function offsetToMinutes(tz: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

interface WallTime {
  ymd: string; // YYYY-MM-DD of the wall clock
  hour: number;
  iso: string; // re-emitted ISO in the hotel offset
  valid: boolean;
}

// Convert an instant to the hotel's fixed-offset wall clock without needing an
// IANA zone name (the contract is an offset like "+08:00"). We shift the epoch
// by the offset and read UTC fields, which gives the local wall time exactly.
function toWall(iso: string, tz: string): WallTime {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { ymd: "", hour: -1, iso, valid: false };
  }
  const offMin = offsetToMinutes(tz);
  const w = new Date(d.getTime() + offMin * 60_000);
  const ymd = `${w.getUTCFullYear()}-${pad(w.getUTCMonth() + 1)}-${pad(w.getUTCDate())}`;
  const out = `${ymd}T${pad(w.getUTCHours())}:${pad(w.getUTCMinutes())}:${pad(w.getUTCSeconds())}${tz}`;
  return { ymd, hour: w.getUTCHours(), iso: out, valid: true };
}

function shiftDateFor(iso: string, tz: string): { shiftDate: string; iso: string } {
  const wall = toWall(iso, tz);
  if (!wall.valid) return { shiftDate: "", iso };

  if (wall.hour >= SHIFT_START_HOUR) {
    // Late evening — the shift is labelled by today.
    return { shiftDate: wall.ymd, iso: wall.iso };
  }
  if (wall.hour < SHIFT_END_HOUR) {
    // After midnight, before 07:00 — belongs to yesterday's 23:00 shift.
    const prev = new Date(new Date(iso).getTime() + offsetToMinutes(tz) * 60_000 - 86_400_000);
    const ymd = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
    return { shiftDate: ymd, iso: wall.iso };
  }
  // Daytime (07:00-22:59): attribute to the upcoming night shift.
  return { shiftDate: wall.ymd, iso: wall.iso };
}

// Merge both sources; normalise timestamps to the hotel TZ; assign each event
// its shiftDate; sort chronologically; flag approximate times and suspected
// duplicates (same room+guest+type within 10 minutes).
export function normalise(
  events: CanonicalEvent[],
  tz: string,
): { events: CanonicalEvent[]; flags: DataQualityFlag[] } {
  const flags: DataQualityFlag[] = [];

  const normalised = events.map((e) => {
    const { shiftDate, iso } = shiftDateFor(e.timestamp, tz);
    if (!shiftDate) {
      flags.push({
        type: "approximate_timestamp",
        eventIds: [e.id],
        note: `Unparseable timestamp "${e.timestamp}"; left as-is, no shift assigned.`,
      });
    }
    if (e.timestampApproximate) {
      flags.push({
        type: "approximate_timestamp",
        eventIds: [e.id],
        note: "Timestamp was approximate in the source; best-guess used.",
      });
    }
    return { ...e, timestamp: iso, shiftDate };
  });

  normalised.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
  );

  // Suspected duplicates — only when room+guest+type all match and within 10min.
  for (let i = 0; i < normalised.length; i++) {
    for (let j = i + 1; j < normalised.length; j++) {
      const a = normalised[i]!;
      const b = normalised[j]!;
      if (!a.room || !a.guest) break;
      if (a.type !== b.type || a.room !== b.room || a.guest !== b.guest) continue;
      const dt = Math.abs(new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      if (dt <= 10 * 60_000) {
        flags.push({
          type: "duplicate_suspected",
          eventIds: [a.id, b.id],
          note: `Possible duplicate: same room/guest/type within 10 minutes.`,
        });
      }
    }
  }

  return { events: normalised, flags };
}
