// Single source of truth for the app version, shown subtly at the bottom
// of the Settings tab. Keep this in sync with the APP_VERSION constant
// duplicated in sw.js (service workers can't import ES modules from a
// classic script scope) — bump both together on every deploy.
export const APP_VERSION = '1.9.3';
