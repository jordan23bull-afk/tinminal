export const TF_SECONDS = {
  "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
};

export function floorTs(ts, tfSeconds) {
  return ts - (ts % tfSeconds);
}

export const POC_IDS = ["poc", "din_poc", "poc30", "poc60", "poc120", "poc240", "poc480", "poc_day"];
export const POC_PRESET_IDS = ["poc30", "poc60", "poc120", "poc240", "poc480"];
export const HEAVY_INDICATOR_IDS = ["poc", "din_poc", "poc30", "poc60", "poc120", "poc240", "poc480", "poc_day"];
export const HEAVY_INDICATOR_TYPES = new Set(HEAVY_INDICATOR_IDS);
export const POC_PRESET_TYPES = new Set(POC_PRESET_IDS);

export function isPoc(indId, type) {
  return HEAVY_INDICATOR_IDS.includes(indId) || (type && HEAVY_INDICATOR_IDS.includes(type));
}

export function isPocPreset(indId, type) {
  return POC_PRESET_IDS.includes(indId) || (type && POC_PRESET_IDS.includes(type));
}