import { IconClose } from "./icons";
import type { Toast } from "./useCapture";

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="ctoasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`ctoast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <header>
            <span>{t.title}</span>
            <button className="btn icon ghost" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              <IconClose />
            </button>
          </header>
          {t.message && <p>{t.message}</p>}
          {t.actions && t.actions.length > 0 && (
            <div className="acts">
              {t.actions.map((a) => (
                <button
                  key={a.label}
                  className="btn"
                  onClick={() => {
                    a.run();
                    dismiss(t.id);
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
