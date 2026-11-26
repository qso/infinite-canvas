export const APP_VERSION = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env?.VITE_DOC_URL || "https://docs.canvas.best";
