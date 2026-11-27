// Runs only in a report served by the local monitor.
(() => {
  const status = document.getElementById("stream-status");
  const list = document.getElementById("session-list");
  const version = document.querySelector('meta[name="report-version"]').content;
  const feed = new EventSource("events?version=" + encodeURIComponent(version));

  function setStatus(state, label) {
    status.dataset.state = state;
    if (status.textContent !== label) status.textContent = label;
  }

  function update(patch) {
    const rows = new Map(Array.from(list.children, (row) => [row.dataset.sessionKey, row]));
    const active = document.activeElement;
    const focused = active?.closest("details[data-session-key]");
    const inventory = list.parentElement;
    const viewport = inventory.getBoundingClientRect();
    const y = Math.max(0, viewport.top) + 46;
    const firstVisible =
      y < Math.min(innerHeight, viewport.bottom)
        ? document
            .elementFromPoint(Math.max(0, viewport.left + 35), y)
            ?.closest("details[data-session-key]")
        : null;
    const focusBox = focused?.getBoundingClientRect();
    const reading =
      focusBox &&
      focusBox.bottom > Math.max(0, viewport.top) &&
      focusBox.top < Math.min(viewport.bottom, innerHeight);
    const anchor = reading ? focused : firstVisible;
    const offset = anchor?.getBoundingClientRect().top;
    const inspecting = !!focused || inventory.scrollTop > 0 || list.querySelector("details[open]");
    for (const [id, html] of Object.entries(patch.panels)) {
      const panel = document.getElementById(id);
      if (panel) panel.innerHTML = html;
    }
    for (const [key, html] of patch.changed) {
      const template = document.createElement("template");
      template.innerHTML = html.trim();
      const next = template.content.firstElementChild;
      const previous = rows.get(key);
      if (previous) {
        next.open = previous.open;
        previous.replaceWith(next);
      }
      rows.set(key, next);
    }
    if (patch.order) {
      const keep = new Set(patch.order);
      for (const [key, row] of rows) if (!keep.has(key)) row.remove();
      let cursor = list.firstElementChild;
      // Keep the row under inspection in place as other sessions become more recent.
      const order = inspecting ? [...rows.keys()].filter((key) => keep.has(key)) : patch.order;
      for (const key of order) {
        const row = rows.get(key);
        if (row !== cursor) list.insertBefore(row, cursor);
        cursor = row.nextElementSibling;
      }
    }
    document.dispatchEvent(new Event("report-updated"));
    if (focused && document.activeElement !== active) {
      const target = active.isConnected
        ? active
        : rows.get(focused.dataset.sessionKey)?.querySelector("summary");
      target?.focus({ preventScroll: true });
    }
    const replacement = anchor && rows.get(anchor.dataset.sessionKey);
    if (replacement?.isConnected && replacement.getClientRects().length) {
      inventory.scrollTop += replacement.getBoundingClientRect().top - offset;
    }
  }

  feed.addEventListener("patch", (event) => {
    update(JSON.parse(event.data));
    setStatus("live", "Live");
  });
  feed.addEventListener("ready", () => setStatus("live", "Live"));
  feed.addEventListener("stale", () => setStatus("stale", "Update delayed"));
  feed.onerror = () => setStatus("reconnecting", "Reconnecting");
})();
