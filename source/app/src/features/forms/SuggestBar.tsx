//! Forms ▸ Detect Fields: the bar shown while found places are on the pages.

import { store, useAppState } from "../../store";
import { tr, trn } from "../../i18n";

export function SuggestBar() {
  const app = useAppState();
  const list = app.suggestions;
  if (!list) return null;
  const on = list.filter((s) => s.on).length;
  const all = on === list.length;
  return (
    <div className="suggest-bar" role="toolbar" aria-label={tr("Detect Fields")}>
      <span>
        {trn(list.length, "Found {0} possible field", "Found {0} possible fields")}
        {" · "}
        {tr("click a box to leave it out")}
      </span>
      <button type="button" onClick={() => list.forEach((s, i) => s.on === all && store.toggleSuggestion(i))}>
        {all ? tr("None") : tr("All")}
      </button>
      <button type="button" className="primary" disabled={!on || app.busy} onClick={() => void store.acceptSuggestions()}>
        {trn(on, "Add {0} Field", "Add {0} Fields")}
      </button>
      <button type="button" onClick={() => store.clearSuggestions()}>
        {tr("Cancel")}
      </button>
    </div>
  );
}
