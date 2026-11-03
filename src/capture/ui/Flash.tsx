/**
 * A brief white flash across the whole virtual desktop, shown as feedback
 * when a screenshot is taken. Non-interactive; the Rust side closes this
 * window shortly after the CSS fade finishes (see windows::flash_screen).
 */
export function Flash() {
  return <div className="flash" aria-hidden="true" />;
}
