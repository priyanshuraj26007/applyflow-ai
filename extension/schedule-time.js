// ==========================================
// APPLYFLOW AI — "Send later" time helpers
// ==========================================
// Shared by the LinkedIn window (content script) and the review page.
// Times are the user's own local time; the server stores them as UTC.
const AF_SCHEDULE = (() => {
  const MORNING = { h: 9, m: 30 };          // recruiters read email in the morning
  const MIN_LEAD_MS = 2 * 60 * 1000;         // the server needs ≥1 min; leave a margin
  const MAX_AHEAD_MS = 6 * 24 * 60 * 60 * 1000;

  const at = (date, { h, m }) => { const d = new Date(date); d.setHours(h, m, 0, 0); return d; };
  const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
  const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

  /** Quick choices: in 1 hour, tomorrow morning, and Monday morning when tomorrow is a weekend. */
  function presets(now = new Date()) {
    const list = [];
    const inHour = new Date(now.getTime() + 60 * 60 * 1000);
    inHour.setSeconds(0, 0);
    list.push({ id: "hour", label: "In 1 hour", when: inHour });

    const todayMorning = at(now, MORNING);
    if (todayMorning.getTime() - now.getTime() > 20 * 60 * 1000 && !isWeekend(now)) {
      list.push({ id: "today", label: `Today, ${time(todayMorning)}`, when: todayMorning });
    }
    const tomorrow = at(addDays(now, 1), MORNING);
    list.push({ id: "tomorrow", label: `Tomorrow, ${time(tomorrow)}`, when: tomorrow });
    if (isWeekend(tomorrow)) {
      let monday = tomorrow;
      while (isWeekend(monday)) monday = addDays(monday, 1);
      list.push({ id: "monday", label: `${monday.toLocaleDateString(undefined, { weekday: "long" })}, ${time(monday)}`, when: monday });
    }
    return list;
  }

  const time = (d) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  /** "Tomorrow, 9:30 AM" / "Today, 6:00 PM" / "Mon 17 Nov, 9:30 AM" */
  function label(value, now = new Date()) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const days = Math.round((at(d, { h: 0, m: 0 }) - at(now, { h: 0, m: 0 })) / 864e5);
    const day = days === 0 ? "Today" : days === 1 ? "Tomorrow"
      : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
    return `${day}, ${time(d)}`;
  }

  /** Value for <input type="datetime-local"> (local time, no seconds). */
  function toInput(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** null if OK, otherwise a short reason. */
  function problem(value, now = Date.now()) {
    const t = new Date(value).getTime();
    if (!value || Number.isNaN(t)) return "Pick a date and time.";
    if (t < now + MIN_LEAD_MS) return "Pick a time at least 2 minutes from now.";
    if (t > now + MAX_AHEAD_MS) return "You can schedule up to 6 days ahead.";
    return null;
  }

  const limits = (now = Date.now()) => ({
    min: toInput(new Date(now + MIN_LEAD_MS)),
    max: toInput(new Date(now + MAX_AHEAD_MS))
  });

  return { presets, label, toInput, problem, limits };
})();
