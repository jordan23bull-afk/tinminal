// Адрес сервера.
//
// По умолчанию берётся origin страницы: так приложение работает и когда его
// отдаёт тот же сервер, и когда статика положена отдельно (nginx, диск) —
// достаточно задать window.__API_BASE__ до загрузки модулей.

function readParam(name) {
  try {
    return new URLSearchParams(location.search).get(name);
  } catch {
    return null;
  }
}

function resolve() {
  // 1. Явно заданный адрес (например <script>window.__API_BASE__=...</script>)
  if (typeof window !== "undefined" && window.__API_BASE__) {
    return String(window.__API_BASE__).replace(/\/+$/, "");
  }
  // 2. Параметр в адресе страницы: ?api=http://10.0.0.5:5000
  const fromQuery = readParam("api");
  if (fromQuery) return fromQuery.replace(/\/+$/, "");
  // 3. Файл открыт с диска — тогда сервер по умолчанию на localhost
  if (location.protocol === "file:") return "http://localhost:5000";
  return location.origin;
}

export const API_BASE = resolve();

export function apiUrl(path) {
  if (!path) return API_BASE;
  return `${API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}