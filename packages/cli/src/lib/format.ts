/**
 * Human-readable date formatter for CLI lists.
 *
 * Displays timestamps in local time with an explicit UTC offset so users can
 * reason about when an investigation happened without mentally converting from
 * ISO-8601. Example: 2026-06-16 14:49 (UTC+03:00)
 */
export function formatDateTime(date: Date | string | number | null | undefined): string {
  if (date == null) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return String(date);

  const tzOffset = -d.getTimezoneOffset();
  const sign = tzOffset >= 0 ? '+' : '-';
  const offsetHours = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
  const offsetMins = String(Math.abs(tzOffset) % 60).padStart(2, '0');

  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');

  return `${y}-${m}-${day} ${h}:${min} (UTC${sign}${offsetHours}:${offsetMins})`;
}
