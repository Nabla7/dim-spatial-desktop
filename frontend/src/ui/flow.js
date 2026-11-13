// Which side panels of a flat screen stay, and in which column each one stands. No drawing here: the
// dock turns the answer into places.
//
// A side is a set of columns that start at the edge of the screen and grow toward its middle. A panel
// goes into the first column that has room under what is already there.
// - A kept panel (the user pinned it) always gets a place, in a new column when none has room.
// - The newest of the others always gets a place too: a panel that was just opened is shown.
// - An older one that is not kept stays only where a column still has room. This is the rule panels
//   always had: on one side, a tool gives way to the next tool.
//
// panels: [{height, kept, order}], order rising with the time a panel was opened.
// Returns {columns: [[panel, ...], ...] (the first is at the edge, each from top to bottom), closed: [panel, ...]}.
export function flow(panels, available, gap) {
  const columns = [], closed = [];
  const used = column => column.reduce((sum, panel) => sum + panel.height + gap, -gap);
  const place = (panel, mayAdd) => {
    const column = columns.find(entry => used(entry) + gap + panel.height <= available + 1e-6);
    if (column) column.push(panel); else if (mayAdd) columns.push([panel]); else return false;
    return true;
  };
  const byAge = [...panels].sort((a, b) => a.order - b.order);
  const kept = byAge.filter(panel => panel.kept), loose = byAge.filter(panel => !panel.kept), newest = loose.pop();
  for (const panel of kept) place(panel, true);
  if (newest) place(newest, true);
  for (const panel of loose.reverse()) if (!place(panel, false)) closed.push(panel);
  // In a column the older panel is above the newer one, so one that opens never moves another down.
  for (const column of columns) column.sort((a, b) => a.order - b.order);
  return {columns, closed};
}
