import "./StatusBar.css";

/**
 * Status bar displayed at the bottom of the application window.
 * Provides left, center, and right sections for future status items.
 */
export function StatusBar() {
  return (
    <div className="status-bar">
      <div className="status-bar__section status-bar__section--left" />
      <div className="status-bar__section status-bar__section--center" />
      <div className="status-bar__section status-bar__section--right" />
    </div>
  );
}
