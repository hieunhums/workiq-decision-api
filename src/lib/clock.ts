/**
 * The date and time where the person is, as a line the model can read.
 *
 * The realtime model has no clock. Without this it takes the first thing a
 * lookup returns as "today", and late at night that is tomorrow's calendar.
 */
export function now(): string {
  const zone = process.env.USER_TIME_ZONE || "UTC";
  const when = new Date().toLocaleString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: zone,
  });
  return `It is now ${when} for the person (${zone}). All times below are in that zone.`;
}
