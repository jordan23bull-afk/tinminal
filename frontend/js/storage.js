const SAVE_DEBOUNCE = 500;
let _timer = null;

function _getAll() {
  const data = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    data[key] = localStorage.getItem(key);
  }
  return data;
}

function _save() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(_getAll()),
    }).catch(() => {});
  }, SAVE_DEBOUNCE);
}

export async function loadFromServer() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    if (data && typeof data === "object") {
      for (const [key, val] of Object.entries(data)) {
        if (localStorage.getItem(key) === null) {
          localStorage.setItem(key, val);
        }
      }
    }
  } catch (e) {
    console.warn("Could not load settings from server:", e);
  }
}

const _origSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function (key, value) {
  _origSetItem(key, value);
  _save();
};
