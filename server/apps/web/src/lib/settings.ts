export interface ConnectionSettings {
  baseUrl: string;
  token: string;
}

const STORAGE_KEY = "session-hub.connection";
const CHANGE_EVENT = "session-hub.connection-changed";

export function loadConnection(): ConnectionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ConnectionSettings>;
      return { baseUrl: parsed.baseUrl ?? "", token: parsed.token ?? "" };
    }
  } catch {
    // corrupted storage falls through to defaults
  }
  return { baseUrl: "", token: "" };
}

export function saveConnection(settings: ConnectionSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function onConnectionChange(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
