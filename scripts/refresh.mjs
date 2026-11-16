/** The Marketplace windows drawn now (one per client; kept as a set so nothing assumes it). */
const openApps = new Set();
let refreshTimer = null;
let refreshAll = false;
const refreshOnly = [];

/** Redraw open windows soon (calls close together make one redraw): all of them, or only those `only` picks. */
function refresh(only = null) {
  if (typeof only === "function") refreshOnly.push(only);
  else refreshAll = true;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const all = refreshAll, picks = refreshOnly.splice(0);
    refreshAll = false;
    for (const app of openApps) if (app.rendered && (all || picks.some((f) => f(app)))) app.render();
  }, 100);
}

/** A window showing the trade log (a GM's). */
const showsLog = (app) => app.isGM && app.view.log && !app.view.post;
/** A window that shows this actor's items or money now: its shop, the chosen trader, a vault or the Trade Post. */
const showsActor = (id) => (app) => app.showsActor?.(id) ?? true;

export { openApps, refresh, showsLog, showsActor };
