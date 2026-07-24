export type { ThemeColors, ThemeDefinition } from "./types";
export { darkTheme } from "./dark";
export { lightTheme } from "./light";
export { solarizedDarkTheme } from "./solarized-dark";
export { solarizedLightTheme } from "./solarized-light";
export {
  applyTheme,
  previewTheme,
  getXtermTheme,
  getCurrentTheme,
  onThemeChange,
  dispose,
} from "./engine";
export type { ColorToken, ColorTokenGroup } from "./colorTokens";
export { COLOR_TOKEN_GROUPS, COLOR_TOKEN_KEYS } from "./colorTokens";
export {
  BASE_THEMES,
  BASE_THEME_ORDER,
  CUSTOM_THEME_PREFIX,
  customThemeSetting,
  isCustomThemeSetting,
  customThemeId,
  resolveBaseTheme,
  generateThemeId,
  dedupeThemeName,
  createCustomTheme,
  findCustomTheme,
  resolveCustomTheme,
} from "./customThemes";
