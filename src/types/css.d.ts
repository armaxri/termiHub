/**
 * Ambient augmentation for the non-standard CSS `zoom` property.
 *
 * `zoom` is widely supported by browsers (and used by {@link useWebviewZoom} to
 * scale the whole webview) but is not part of the standard `CSSStyleDeclaration`
 * type shipped with TypeScript's DOM lib. Declaring it here keeps
 * `document.documentElement.style.zoom` typed without per-site casts.
 */
interface CSSStyleDeclaration {
  zoom: string;
}
