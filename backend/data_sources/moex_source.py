import threading
import logging
import requests
import sys
import os
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from core.interfaces import IDataSource
from core.registry import ModuleRegistry

logger = logging.getLogger(__name__)

BOARDS = {
    "shares": {"engine": "stock", "market": "shares", "board": "TQBR"},
    "futures": {"engine": "futures", "market": "forts", "board": "RFUD"},
    "index": {"engine": "stock", "market": "index", "board": "SNDX"},
}

TF_MAP = {
    "1m": "1", "10m": "10",
    "1h": "60",
    "1d": "24",
}

TF_SECONDS = {"1m": 60, "10m": 600, "1h": 3600, "1d": 86400}

class MoexSource(IDataSource):
    def __init__(self):
        self._stop_events = {}
        self._lock = threading.Lock()

    @property
    def name(self):
        return "moex"

    @property
    def supported_timeframes(self):
        return ["1m", "10m", "1h", "1d"]

    def _resolve_ticker(self, symbol):
        return symbol.upper()

    INDEX_TICKERS = {"IMOEX", "IMOEX2", "MOEX", "MOEX2", "RTSI", "RTSI2", "MOEXFN", "MOEXOG", "MOEXMM", "MOEXCN", "MOEXEL", "MOEXFN2", "MOEXOG2", "MOEXMM2", "MOEXCN2", "MOEXEL2"}

    def _parse_symbol(self, symbol):
        s = symbol.upper()
        if s.startswith("FUT:"):
            return s[4:], "futures"
        if s in self.INDEX_TICKERS or (s.endswith("X") and s.startswith("IMO")):
            return s, "index"
        return s, "shares"

    def _iss_url(self, board_type, ticker, endpoint):
        b = BOARDS[board_type]
        return (
            f"https://iss.moex.com/iss/engines/{b['engine']}/markets/{b['market']}/boards/{b['board']}/"
            f"securities/{ticker}{endpoint}"
        )

    def _fetch_candles(self, ticker, interval, from_date, to_date, start=0, board_type="shares"):
        url = self._iss_url(board_type, ticker, "/candles.json")
        url += f"?from={from_date}&till={to_date}&interval={interval}&start={start}&iss.meta=off&iss.json=extended"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list) or len(data) < 2:
            return []
        return data[1].get("candles", [])

    def _fetch_all_candles(self, ticker, interval, from_date, to_date, board_type="shares"):
        all_candles = []
        start = 0
        while True:
            batch = self._fetch_candles(ticker, interval, from_date, to_date, start, board_type)
            if not batch:
                break
            all_candles.extend(batch)
            if len(batch) < 500:
                break
            start += 500
        return all_candles

    def get_historical_data(self, symbol, timeframe, limit=500):
        ticker, board_type = self._parse_symbol(symbol)
        ticker = self._resolve_ticker(ticker)
        interval = TF_MAP.get(timeframe, "60")
        tf_sec = TF_SECONDS.get(timeframe, 3600)

        now = datetime.now(timezone.utc)
        lookback_sec = max(limit * tf_sec, 2 * 86400)
        from_date = (now - timedelta(seconds=lookback_sec)).strftime("%Y-%m-%d")
        to_date = now.strftime("%Y-%m-%d")

        try:
            all_candles = self._fetch_all_candles(ticker, interval, from_date, to_date, board_type)

            if not all_candles and board_type == "shares":
                board_type = "futures"
                all_candles = self._fetch_all_candles(ticker, interval, from_date, to_date, board_type)

            if not all_candles:
                return []

            result = []
            for row in all_candles:
                dt = datetime.strptime(row["begin"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                result.append({
                    "time": int(dt.timestamp()),
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": int(row["volume"]),
                })

            return result[-limit:] if len(result) > limit else result

        except Exception as e:
            logger.error(f"[MOEX] Error fetching candles for {ticker}: {e}")
            raise

    def subscribe_realtime(self, symbol, timeframe, callback):
        ticker, board_type = self._parse_symbol(symbol)
        ticker = self._resolve_ticker(ticker)
        interval = TF_MAP.get(timeframe, "60")
        interval_sec = TF_SECONDS.get(timeframe, 3600)
        key = (symbol, timeframe)

        with self._lock:
            if key in self._stop_events:
                return True
            stop_event = threading.Event()
            self._stop_events[key] = stop_event
        last_broadcast = {"time": 0, "price": 0, "volume": 0}
        current_candle = {"open": None, "high": None, "low": None, "volume": 0}
        vol_baseline = 0

        def get_candle_time(server_time):
            ms = server_time.astimezone(timezone(timedelta(hours=3)))
            if interval_sec >= 3600:
                aligned = ms.replace(minute=0, second=0, microsecond=0)
            else:
                msk_minutes = ms.hour * 60 + ms.minute
                aligned_minutes = msk_minutes - (msk_minutes % (interval_sec // 60))
                h = aligned_minutes // 60
                m = aligned_minutes % 60
                aligned = ms.replace(hour=h, minute=m, second=0, microsecond=0)
            return int(aligned.timestamp())

        active_board = board_type

        def stream():
            nonlocal active_board, vol_baseline
            logger.info(f"[MOEX] Stream started for {ticker} {timeframe}")
            first_poll = True
            consecutive_errors = 0
            try:
                while not stop_event.is_set():
                    try:
                        url = self._iss_url(active_board, ticker, ".json")
                        url += "?iss.meta=off"

                        resp = requests.get(url, timeout=5)
                        resp.raise_for_status()
                        data = resp.json()
                        consecutive_errors = 0

                        if isinstance(data, dict):
                            md_list = data.get("marketdata", {}).get("data", [])
                            md_cols = data.get("marketdata", {}).get("columns", [])
                        else:
                            md_list = []
                            md_cols = []

                        if md_list and md_cols:
                            row = md_list[0]
                            last_idx = md_cols.index("LAST") if "LAST" in md_cols else md_cols.index("LASTVALUE") if "LASTVALUE" in md_cols else None
                            high_idx = md_cols.index("HIGH") if "HIGH" in md_cols else None
                            low_idx = md_cols.index("LOW") if "LOW" in md_cols else None
                            vol_idx = md_cols.index("VOLTODAY") if "VOLTODAY" in md_cols else md_cols.index("VALTODAY") if "VALTODAY" in md_cols else None
                            ts_idx = md_cols.index("SYSUPDATED") if "SYSUPDATED" in md_cols else None

                            if last_idx is not None and row[last_idx] is not None:
                                price = float(row[last_idx])
                                high = float(row[high_idx]) if high_idx is not None and row[high_idx] is not None else price
                                low = float(row[low_idx]) if low_idx is not None and row[low_idx] is not None else price
                                volume = int(row[vol_idx]) if vol_idx is not None and row[vol_idx] is not None else 0

                                server_time = None
                                if ts_idx is not None and row[ts_idx]:
                                    try:
                                        server_time = datetime.strptime(str(row[ts_idx]), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                                    except ValueError:
                                        pass
                                if server_time is None:
                                    server_time = datetime.now(timezone.utc)

                                candle_time = get_candle_time(server_time)

                                if candle_time != last_broadcast["time"]:
                                    current_candle["open"] = price
                                    current_candle["high"] = price
                                    current_candle["low"] = price
                                    current_candle["volume"] = 0
                                    vol_baseline = volume
                                else:
                                    if current_candle["high"] is None or price > current_candle["high"]:
                                        current_candle["high"] = price
                                    if current_candle["low"] is None or price < current_candle["low"]:
                                        current_candle["low"] = price

                                current_candle["volume"] = max(0, volume - vol_baseline)

                                if candle_time != last_broadcast["time"] or price != last_broadcast["price"] or volume != last_broadcast["volume"]:
                                    last_broadcast["time"] = candle_time
                                    last_broadcast["price"] = price
                                    last_broadcast["volume"] = volume
                                    callback({
                                        "time": candle_time,
                                        "open": current_candle["open"],
                                        "high": current_candle["high"],
                                        "low": current_candle["low"],
                                        "close": price,
                                        "volume": current_candle["volume"],
                                    })
                                    logger.info(f"[MOEX] {ticker}: {price} @ {candle_time} (H={current_candle['high']} L={current_candle['low']})")
                                else:
                                    logger.debug(f"[MOEX] {ticker}: no change, last={price}")
                            else:
                                logger.info(f"[MOEX] {ticker}: price data unavailable (market closed?)")
                        else:
                            if first_poll and active_board == "shares":
                                active_board = "futures"
                                first_poll = False
                                logger.info(f"[MOEX] {ticker}: no shares data, trying futures")
                                continue
                            if active_board == "futures":
                                active_board = "index"
                                logger.info(f"[MOEX] {ticker}: no futures data, trying index")
                                continue
                            logger.info(f"[MOEX] {ticker}: no market data returned")
                    except Exception as e:
                        consecutive_errors += 1
                        logger.error(f"[MOEX] Poll error for {ticker} (attempt {consecutive_errors}): {e}")

                    first_poll = False
                    wait_sec = min(3 * (2 ** min(consecutive_errors, 4)), 48)
                    stop_event.wait(wait_sec)
            finally:
                with self._lock:
                    self._stop_events.pop(key, None)
                logger.info(f"[MOEX] Stream ended for {ticker} {timeframe}")

        threading.Thread(target=stream, daemon=True).start()
        return True

    def _fetch_board_prices(self, tickers, board_type):
        result = {}
        if not tickers:
            return result
        b = BOARDS[board_type]
        url = f"https://iss.moex.com/iss/engines/{b['engine']}/markets/{b['market']}/boards/{b['board']}/securities.json"
        url += f"?iss.meta=off&iss.json=extended&securities={','.join(tickers)}"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list) or len(data) < 2:
            return result
        for row in data[1].get("marketdata", []):
            ticker = row.get("SECID")
            price = row.get("LAST") or row.get("LASTVALUE")
            if not ticker or price is None:
                continue
            change = row.get("LASTCHANGE") or row.get("LASTCHANGEPRC")
            change_pct = row.get("LASTTOPREVPRICE") or row.get("LASTCHANGETOOPENPRC")
            result[ticker.upper()] = {
                "price": float(price),
                "change": float(change) if change is not None else None,
                "changePct": float(change_pct) if change_pct is not None else None,
            }
        return result

    def get_prices(self, symbols):
        by_board = {}
        raw_tickers = {}
        for s in symbols:
            ticker, board_type = self._parse_symbol(s)
            ticker = self._resolve_ticker(ticker)
            raw_tickers[s] = ticker
            by_board.setdefault(board_type, []).append(ticker)

        result = {}
        for board_type, tickers in by_board.items():
            result.update(self._fetch_board_prices(tickers, board_type))

        # ponytail: fallback chain — try other boards for missing symbols
        for fallback_board in ("futures", "index"):
            missing = [s for s in symbols if self._resolve_ticker(s).upper() not in result]
            if not missing:
                break
            result.update(self._fetch_board_prices(
                [self._resolve_ticker(s).upper() for s in missing], fallback_board
            ))

        return result

    def unsubscribe_realtime(self, symbol, timeframe):
        key = (symbol, timeframe)
        with self._lock:
            event = self._stop_events.pop(key, None)
        if event:
            event.set()
        return True


ModuleRegistry.register_data_source(MoexSource)
