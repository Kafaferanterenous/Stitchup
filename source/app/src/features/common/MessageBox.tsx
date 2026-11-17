import { useAppState, store } from "../../store";

import { tr } from "../../i18n";

export function MessageBox() {
  const app = useAppState();
  if (!app.lastError) {
    return null;
  }
  return (
    <div className="error-toast" role="alert">
      <span>{app.lastError.message}</span>
      <button onClick={() => store.clearError()}>{tr("Dismiss")}</button>
    </div>
  );
}