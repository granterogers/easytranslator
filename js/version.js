// Single source of truth for the app version shown in Settings.
// Keep this in sync with the APP_VERSION constant duplicated in sw.js
// (service workers can't import ES modules from a classic script scope) —
// bump both together on every deploy.
export const APP_VERSION = '1.3.1';
