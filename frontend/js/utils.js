export function generateId() {
  return `chart_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
}

export function log(msg, ...args) {
  console.log(`[TradingDashboard] ${msg}`, ...args);
}
