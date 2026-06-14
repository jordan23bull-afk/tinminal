export function debounce(fn, delay = 150) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

export function formatPrice(price) {
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTime(unixSeconds) {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleString();
}

export function generateId() {
  return `chart_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
}

export function log(msg, ...args) {
  console.log(`[TradingDashboard] ${msg}`, ...args);
}
