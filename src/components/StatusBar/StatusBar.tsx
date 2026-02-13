import { useAppStore } from "@/store/appStore";
import "./StatusBar.css";

/**
 * Status bar displayed at the bottom of the application window.
 * Shows editor status (cursor position, language, EOL, tab size, encoding)
 * when an editor tab is active.
 */
export function StatusBar() {
  const editorStatus = useAppStore((s) => s.editorStatus);
  const editorActions = useAppStore((s) => s.editorActions);

  return (
    <div className="status-bar">
      <div className="status-bar__section status-bar__section--left" />
      <div className="status-bar__section status-bar__section--center" />
      <div className="status-bar__section status-bar__section--right">
        {editorStatus && (
          <>
            <span className="status-bar__item">
              Ln {editorStatus.line}, Col {editorStatus.column}
            </span>
            <button
              className="status-bar__item status-bar__item--interactive"
              onClick={() => editorActions?.cycleTabSize()}
              title="Toggle tab size"
            >
              Spaces: {editorStatus.tabSize}
            </button>
            <span className="status-bar__item">{editorStatus.encoding}</span>
            <button
              className="status-bar__item status-bar__item--interactive"
              onClick={() => editorActions?.toggleEol()}
              title="Toggle line endings"
            >
              {editorStatus.eol}
            </button>
            <span className="status-bar__item">{editorStatus.language}</span>
          </>
        )}
      </div>
    </div>
  );
}
