// Wrap complete week columns without filtering the calendar's date range.
// Cell indices remain global so keyboard navigation crosses the panel boundary.
export function githubCalendarSections(calendar, splitPanels = false) {
  const split = splitPanels ? Math.ceil(calendar.weeks / 2) * 7 : calendar.cells.length;
  return [0, ...(splitPanels && split < calendar.cells.length ? [split] : [])].map((start, index, starts) => {
    const cells = calendar.cells.slice(start, starts[index + 1] ?? calendar.cells.length);
    const dates = cells.filter(Boolean);
    const month = (date) => date.slice(0, 7).replace('-', '.');
    return { start, cells, weeks: cells.length / 7,
      label: dates.length ? `${month(dates[0].date)} — ${month(dates.at(-1).date)}` : '' };
  });
}

export function githubContributionWindow(days, range = 'year') {
  if (!days.length) return [];
  const end = new Date(`${days.at(-1).date}T00:00:00Z`), start = new Date(end);
  if (range === 'week') start.setUTCDate(start.getUTCDate() - 6);
  else {
    const months = range === 'month' ? 1 : range === 'half-year' ? 6 : 12;
    const date = start.getUTCDate();
    start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - months);
    const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(date, lastDay)); start.setUTCDate(start.getUTCDate() + 1);
  }
  const first = start.toISOString().slice(0, 10);
  return days.filter((day) => day.date >= first);
}

// Recent complete week columns, using one physical square size throughout.
// Large wraps into two seven-row panels; padding is never contribution data.
export function githubWidgetCalendar(calendar, size, bounds = {}) {
  const panels = size === 'large' ? 2 : 1, rows = panels * 7;
  const width = bounds.width > 0 ? bounds.width : size === 'medium' ? 380 : 196;
  const height = bounds.height > 0 ? bounds.height : size === 'large' ? 380 : 196;
  const columns = Math.max(3, Math.min(28, Math.ceil(calendar.weeks / panels), Math.round(width / height * rows)));
  const ratio = .2;
  const cell = Math.min(width / (columns + ratio * (columns - 1)), height / (rows + ratio * (rows - 1)));
  const gap = cell * ratio, slots = columns * rows;
  const cells = calendar.cells.slice(-slots);
  while (cells.length < slots) cells.unshift(null);
  const sections = Array.from({ length: panels }, (_, index) => {
    const start = index * columns * 7;
    return { start, cells: cells.slice(start, start + columns * 7) };
  });
  return { columns, cell, gap, cells, sections };
}

