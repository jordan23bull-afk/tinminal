import os
import sys
import time
import threading
import logging
import math
import grpc

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "gen"))

from tinkoff.invest.grpc import marketdata_pb2, marketdata_pb2_grpc
from tinkoff.invest.grpc import instruments_pb2, instruments_pb2_grpc
from google.protobuf.timestamp_pb2 import Timestamp

from core.interfaces import IDataSource
from core.registry import ModuleRegistry
from core.database import save_candles, load_candles, get_latest_time, get_prev_session_close
from core.tls import ensure_bundle, root_certificates_bytes

ensure_bundle()

logger = logging.getLogger(__name__)

PROD_TARGET = "invest-public-api.tinkoff.ru:443"
APP_NAME = "tinkoff.invest-python"
APP_VERSION = "0.2.0-beta117"

TOKEN_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "token.txt")

TF_MAP = {
    "1m": marketdata_pb2.CANDLE_INTERVAL_1_MIN,
    "5m": marketdata_pb2.CANDLE_INTERVAL_5_MIN,
    "10m": marketdata_pb2.CANDLE_INTERVAL_10_MIN,
    "15m": marketdata_pb2.CANDLE_INTERVAL_15_MIN,
    "30m": marketdata_pb2.CANDLE_INTERVAL_30_MIN,
    "1h": marketdata_pb2.CANDLE_INTERVAL_HOUR,
    "2h": marketdata_pb2.CANDLE_INTERVAL_2_HOUR,
    "4h": marketdata_pb2.CANDLE_INTERVAL_4_HOUR,
    "1d": marketdata_pb2.CANDLE_INTERVAL_DAY,
}

TF_SECONDS = {
    "1m": 60, "5m": 300, "10m": 600, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
}

GRPC_OPTIONS = [
    ("grpc.keepalive_time_ms", 10000),
    ("grpc.keepalive_timeout_ms", 5000),
    ("grpc.max_receive_message_length", 10 * 1024 * 1024),
]

RESYNC_INTERVAL = 2.0
STREAM_IDLE_TIMEOUT = 30.0

# History paging: Tinkoff caps GetCandles at 1000 per call. For larger requests
# we page backwards and pause between calls to stay within rate limits.
MAX_HISTORY_CANDLES = 3000
HISTORY_PAGE_PAUSE = 0.4


def floor_ts(ts, tf_seconds):
    return ts - (ts % tf_seconds)


def _quotation_to_float(q):
    return q.units + q.nano / 1e9


class TinkoffSource(IDataSource):
    def __init__(self):
        self._lock = threading.Lock()
        self._instruments = {}      # upper ticker -> meta dict
        self._wanted = {}           # (symbol, timeframe) -> (figi, interval)
        self._callbacks = {}        # (symbol, timeframe) -> callback
        self._by_wire = {}          # (figi, interval) -> set of (symbol, timeframe)
        self._last_time = {}        # (figi, interval) -> last candle time (epoch sec)
        self._last_sent = set()     # wires currently sent to server
        self._stream_thread = None
        self._stream_stop = threading.Event()
        self._empty_since = None      # monotonic ts when _wanted became empty
        self._prev_close_cache = {}  # figi -> (close_value | None, ts)
        self._channel_cache = None   # cached gRPC channel for history requests

    # ------------------------------------------------------------------ #
    # auth / transport
    # ------------------------------------------------------------------ #
    @property
    def name(self):
        return "tinkoff"

    @property
    def supported_timeframes(self):
        return list(TF_MAP.keys())

    def _token(self):
        token = os.environ.get("TINKOFF_TOKEN", "").strip()
        if not token and os.path.exists(TOKEN_FILE):
            try:
                with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                    token = f.read().strip()
            except Exception:
                token = ""
        if not token:
            raise ValueError(
                "TINKOFF_TOKEN not set. Export TINKOFF_TOKEN (or create backend/token.txt) "
                "with a read-only T-Invest API token."
            )
        return token

    def _metadata(self):
        return [
            ("authorization", f"Bearer {self._token()}"),
            ("x-app-name", APP_NAME),
            ("x-app-version", APP_VERSION),
        ]

    def _get_channel(self):
        """Get or create a cached gRPC channel for history requests."""
        with self._lock:
            if self._channel_cache is None:
                creds = grpc.ssl_channel_credentials(root_certificates=root_certificates_bytes())
                self._channel_cache = grpc.secure_channel(PROD_TARGET, creds, options=GRPC_OPTIONS)
                logger.info("[TINKOFF] Created cached gRPC channel")
            return self._channel_cache

    def _get_stream_channel(self):
        """Create a dedicated gRPC channel for the live MarketDataStream.

        Separate from the cached history channel so that closing the stream
        (idle stop / reconnect) never invalidates the shared history channel.
        """
        creds = grpc.ssl_channel_credentials(root_certificates=root_certificates_bytes())
        return grpc.secure_channel(PROD_TARGET, creds, options=GRPC_OPTIONS)

    def close(self):
        """Close the cached gRPC channel on shutdown."""
        with self._lock:
            if self._channel_cache is not None:
                try:
                    self._channel_cache.close()
                    logger.info("[TINKOFF] Closed cached gRPC channel")
                except Exception as e:
                    logger.error(f"[TINKOFF] Error closing channel: {e}")
                finally:
                    self._channel_cache = None

    @staticmethod
    def _normalize(symbol):
        s = symbol.strip().upper()
        if s.startswith("FUT:") or s.startswith("FUT/"):
            s = s[4:]
        return s

    # ------------------------------------------------------------------ #
    # instrument resolution (gRPC FindInstrument, cached)
    # ------------------------------------------------------------------ #
    def _find(self, ticker):
        req = instruments_pb2.FindInstrumentRequest(query=ticker)
        try:
            chan = self._get_channel()
            stub = instruments_pb2_grpc.InstrumentsServiceStub(chan)
            resp = stub.FindInstrument(req, metadata=self._metadata())
        except grpc.RpcError as e:
            code = getattr(e.code(), "name", "UNKNOWN")
            if code == "UNAUTHENTICATED":
                raise PermissionError("Tinkoff token is invalid (UNAUTHENTICATED).")
            if code == "RESOURCE_EXHAUSTED":
                raise ConnectionError("Tinkoff API rate limit exceeded. Retry in a moment.")
            raise ConnectionError(f"Tinkoff FindInstrument failed ({code}): {e.details()}")

        instruments = list(resp.instruments)
        if not instruments:
            raise ValueError(f"Instrument {ticker} not found")

        candidates = [i for i in instruments if (i.ticker or "").upper() == ticker]
        if not candidates:
            candidates = instruments

        def sort_key(i):
            itype = i.instrument_type or ""
            traded = 0 if i.api_trade_available_flag else 1
            return (
                0 if itype in ("share", "etf", "bond", "currency", "futures", "index") else 1,
                traded,
                0 if (i.ticker or "").upper() == ticker else 1,
            )

        best = min(candidates, key=sort_key)
        figi = best.figi
        if not figi:
            raise ValueError(f"Instrument {ticker} resolved but has no figi")
        meta = {
            "ticker": (best.ticker or ticker).upper(),
            "figi": figi,
            "instrument_uid": best.uid or figi,
            "name": best.name or ticker,
            "currency": (getattr(best, "currency", "") or "rub").lower(),
            "lot": int(best.lot or 1),
            "instrument_type": best.instrument_type or "",
        }
        logger.info(f"[TINKOFF] Resolved {ticker} -> figi={figi} ({meta['name']})")
        return meta

    def _resolve(self, symbol):
        ticker = self._normalize(symbol)
        with self._lock:
            cached = self._instruments.get(ticker)
        if cached:
            return cached
        meta = self._find(ticker)
        with self._lock:
            self._instruments[ticker] = meta
        return meta

    # ------------------------------------------------------------------ #
    # history (gRPC GetCandles + SQLite cache)
    # ------------------------------------------------------------------ #
    def get_historical_data(self, symbol, timeframe, limit=500):
        ticker = self._normalize(symbol)
        tf_sec = TF_SECONDS.get(timeframe, 3600)
        now = int(time.time())
        # Tinkoff caps each GetCandles call at 1000; for larger requests we
        # page backwards across the time window with a small pause between
        # calls (well within rate limits, so no ban risk).
        target = min(int(limit), MAX_HISTORY_CANDLES)
        lookback = max(target * tf_sec, 2 * 86400)
        from_time = now - lookback

        # cache check (same policy as MOEX source)
        db_candles = load_candles(ticker, timeframe, from_time=from_time, limit=target)
        latest_db = get_latest_time(ticker, timeframe)
        stale = latest_db is None or (now - latest_db) > 300
        if db_candles and not stale:
            logger.info(f"[TINKOFF] Serving {len(db_candles)} candles from DB for {ticker} {timeframe}")
            return db_candles

        meta = self._resolve(ticker)
        interval = TF_MAP.get(timeframe, marketdata_pb2.CANDLE_INTERVAL_HOUR)

        try:
            chan = self._get_channel()
            stub = marketdata_pb2_grpc.MarketDataServiceStub(chan)

            collected = []
            window_to = now
            requests_made = 0
            max_calls = int(math.ceil(target / 1000.0)) + 1
            while len(collected) < target and requests_made < max_calls:
                req = marketdata_pb2.GetCandlesRequest(
                    instrument_id=meta["figi"],
                    interval=interval,
                    limit=min(target, 1000),
                )
                from_ts = Timestamp()
                from_ts.FromSeconds(from_time)
                to_ts = Timestamp()
                to_ts.FromSeconds(window_to)
                getattr(req, "from").CopyFrom(from_ts)
                getattr(req, "to").CopyFrom(to_ts)

                resp = stub.GetCandles(req, metadata=self._metadata())
                page = list(resp.candles)
                requests_made += 1
                if not page:
                    break

                collected.extend(page)
                # move the window to just before the earliest candle we just got
                earliest = min(c.time.seconds for c in page)
                window_to = earliest - 1
                if requests_made < max_calls:
                    time.sleep(HISTORY_PAGE_PAUSE)
                if len(page) < 1000:
                    break

            candles = [self._candle_to_dict(c) for c in collected]
            # de-duplicate by timestamp (windows may overlap)
            seen = set()
            unique = []
            for c in candles:
                if c["time"] in seen:
                    continue
                seen.add(c["time"])
                unique.append(c)
            unique.sort(key=lambda c: c["time"])

            closed = [c for c in unique if c["time"] < floor_ts(now, tf_sec)]
            if closed:
                save_candles(ticker, timeframe, closed)
            logger.info(f"[TINKOFF] Got {len(unique)} candles for {ticker} {timeframe} ({requests_made} calls)")
            return unique[-target:] if len(unique) > target else unique
        except grpc.RpcError as e:
            code = getattr(e.code(), "name", "UNKNOWN")
            if code == "UNAUTHENTICATED":
                raise PermissionError("Tinkoff token is invalid (UNAUTHENTICATED).")
            raise ConnectionError(f"Tinkoff GetCandles failed ({code}): {e.details()}")

    # ------------------------------------------------------------------ #
    # live streaming (one shared gRPC MarketDataStream channel)
    # ------------------------------------------------------------------ #
    def subscribe_realtime(self, symbol, timeframe, callback):
        key = (self._normalize(symbol), timeframe)
        with self._lock:
            if key in self._callbacks:
                return True
        meta = self._resolve(key[0])
        interval = TF_MAP.get(timeframe, marketdata_pb2.CANDLE_INTERVAL_HOUR)
        wire = (meta["figi"], interval)

        with self._lock:
            self._callbacks[key] = callback
            self._wanted[key] = wire
            self._by_wire.setdefault(wire, set()).add(key)
            self._empty_since = None
        self._ensure_stream()
        logger.info(f"[TINKOFF] Subscription wanted: {key} wire={wire}")
        return True

    def unsubscribe_realtime(self, symbol, timeframe):
        key = (self._normalize(symbol), timeframe)
        with self._lock:
            wire = self._wanted.pop(key, None)
            self._callbacks.pop(key, None)
            if wire:
                keys = self._by_wire.get(wire)
                if keys:
                    keys.discard(key)
                    if not keys:
                        self._by_wire.pop(wire, None)
            if self._wanted:
                self._empty_since = None
            elif self._empty_since is None:
                self._empty_since = time.monotonic()
        # no immediate stream teardown: keep it alive across quick switchovers,
        # the stream loop stops it after STREAM_IDLE_TIMEOUT when truly idle
        logger.info(f"[TINKOFF] Unsubscribed: {key}")
        return True

    def _ensure_stream(self):
        with self._lock:
            if self._stream_thread and self._stream_thread.is_alive():
                return
            self._stream_stop.clear()
            self._last_sent = set()
            self._stream_thread = threading.Thread(
                target=self._stream_loop, daemon=True, name="tinkoff-stream"
            )
            self._stream_thread.start()

    def _stream_loop(self):
        delay = 1.0
        while not self._stream_stop.is_set():
            with self._lock:
                idle = not self._wanted
                empty_since = self._empty_since
            if idle:
                if empty_since is not None and time.monotonic() - empty_since > STREAM_IDLE_TIMEOUT:
                    logger.info("[TINKOFF] Stream idle, stopping")
                    self._stream_stop.set()
                    break
                self._stream_stop.wait(2)
                continue
            channel = None
            try:
                with self._lock:
                    self._last_sent = set()  # reconnect => re-subscribe everything
                channel = self._get_stream_channel()
                stub = marketdata_pb2_grpc.MarketDataStreamServiceStub(channel)
                self._resync_missed()
                responses = stub.MarketDataStream(self._requests(), metadata=self._metadata())
                delay = 1.0
                for resp in responses:
                    if self._stream_stop.is_set():
                        break
                    self._dispatch(resp)
                logger.info("[TINKOFF] Stream ended by server, will reconnect")
            except grpc.RpcError as e:
                code = getattr(e.code(), "name", "UNKNOWN")
                logger.error(f"[TINKOFF] Stream error {code}: {e.details()}")
                if code == "UNAUTHENTICATED":
                    logger.error("[TINKOFF] Token invalid (UNAUTHENTICATED)")
            except Exception as e:
                logger.error(f"[TINKOFF] Stream error: {e}")
            finally:
                if channel is not None:
                    try:
                        channel.close()
                    except Exception:
                        pass
                    with self._lock:
                        if self._channel_cache is channel:
                            self._channel_cache = None
            if self._stream_stop.wait(delay):
                break
            delay = min(delay * 2, 15)

    def _requests(self):
        while not self._stream_stop.is_set():
            for msg in self._sync_plan():
                if self._stream_stop.is_set():
                    return
                yield msg
            if self._stream_stop.wait(RESYNC_INTERVAL):
                return

    def _resync_missed(self):
        with self._lock:
            wanted = list(self._by_wire.items())
        if not wanted:
            return
        now = int(time.time())
        for wire, key_set in wanted:
            if not key_set:
                continue
            figi, interval = wire
            last_time = self._last_time.get(wire)
            if last_time is None:
                continue
            misses = max(now - last_time, 0)
            if misses <= 0:
                continue
            try:
                chan = self._get_channel()
                stub = marketdata_pb2_grpc.MarketDataServiceStub(chan)
                req = marketdata_pb2.GetCandlesRequest(
                    instrument_id=figi,
                    interval=interval,
                    limit=1000,
                )
                from_ts = Timestamp()
                from_ts.FromSeconds(last_time)
                to_ts = Timestamp()
                to_ts.FromSeconds(now)
                getattr(req, "from").CopyFrom(from_ts)
                getattr(req, "to").CopyFrom(to_ts)
                resp = stub.GetCandles(req, metadata=self._metadata())
                listed = [self._candle_to_dict(c) for c in resp.candles]
                latest = None
                now_int = int(time.time())
                for candle in listed:
                    if candle["time"] <= last_time:
                        continue
                    latest = candle
                    for key in list(key_set):
                        cb = self._callbacks.get(key)
                        if cb is None:
                            continue
                        try:
                            cb(candle)
                        except Exception as e:
                            logger.error(f"[TINKOFF] resync callback error for {key}: {e}")
                        tf_sec = TF_SECONDS.get(key[1], 60)
                        if candle["time"] < floor_ts(now_int, tf_sec):
                            save_candles(key[0], key[1], [candle])
                if latest is not None:
                    with self._lock:
                        cur = self._last_time.get(wire)
                        if cur is None or latest["time"] > cur:
                            self._last_time[wire] = latest["time"]
                    logger.info(f"[TINKOFF] Resync {figi} missed {len(listed)} candles")
            except Exception as e:
                logger.error(f"[TINKOFF] Resync failed for {figi}: {e}")

    def _sync_plan(self):
        with self._lock:
            wanted = list(self._wanted.values())
            last = set(self._last_sent)
        desired = set(wanted)
        messages = []
        to_sub = desired - last
        if to_sub:
            messages.append(marketdata_pb2.MarketDataRequest(
                subscribe_candles_request=marketdata_pb2.SubscribeCandlesRequest(
                    subscription_action=marketdata_pb2.SUBSCRIPTION_ACTION_SUBSCRIBE,
                    instruments=[
                        marketdata_pb2.CandleInstrument(instrument_id=figi, interval=interval)
                        for figi, interval in to_sub
                    ],
                )
            ))
        to_unsub = last - desired
        if to_unsub:
            messages.append(marketdata_pb2.MarketDataRequest(
                subscribe_candles_request=marketdata_pb2.SubscribeCandlesRequest(
                    subscription_action=marketdata_pb2.SUBSCRIPTION_ACTION_UNSUBSCRIBE,
                    instruments=[
                        marketdata_pb2.CandleInstrument(instrument_id=figi, interval=interval)
                        for figi, interval in to_unsub
                    ],
                )
            ))
        if messages:
            with self._lock:
                self._last_sent = set(self._wanted.values())
        return messages

    def _dispatch(self, resp):
        payload = resp.WhichOneof("payload")
        if payload == "candle":
            c = resp.candle
            wire = (c.figi, c.interval)
            with self._lock:
                keys = list(self._by_wire.get(wire, ()))
                callbacks = [(k, self._callbacks.get(k)) for k in keys]
            if not callbacks:
                return
            candle = self._candle_to_dict(c)
            with self._lock:
                cur = self._last_time.get(wire)
                if cur is None or candle["time"] > cur:
                    self._last_time[wire] = candle["time"]
            now = int(time.time())
            for key, cb in callbacks:
                if cb is None:
                    continue
                try:
                    cb(candle)
                except Exception as e:
                    logger.error(f"[TINKOFF] callback error for {key}: {e}")
                tf_sec = TF_SECONDS.get(key[1], 60)
                if candle["time"] < floor_ts(now, tf_sec):
                    save_candles(key[0], key[1], [candle])
        elif payload and payload.endswith("_response"):
            logger.debug(f"[TINKOFF] {payload}")

    # ------------------------------------------------------------------ #
    # prices (gRPC GetLastPrices)
    # ------------------------------------------------------------------ #
    def _resolve_prev_close(self, meta):
        """Previous-session close: SQLite cache first, Tinkoff day candle as fallback."""
        ticker = meta["ticker"]
        figi = meta["figi"]
        with self._lock:
            cached = self._prev_close_cache.get(figi)
            if cached is not None and time.time() - cached[1] < 3600:
                return cached[0]

        prev = get_prev_session_close(ticker)
        if prev is None:
            prev = self._fetch_prev_close(meta)

        with self._lock:
            self._prev_close_cache[figi] = (prev, time.time())
        return prev

    def _fetch_prev_close(self, meta):
        """Fetch and cache the last closed daily candle for prev_close."""
        now = int(time.time())
        start_of_day = now - (now % 86400)
        ticker = meta["ticker"]
        try:
            req = marketdata_pb2.GetCandlesRequest(
                instrument_id=meta["figi"],
                interval=marketdata_pb2.CANDLE_INTERVAL_DAY,
                limit=1,
            )
            from_ts = Timestamp()
            from_ts.FromSeconds(start_of_day - 7 * 86400)
            to_ts = Timestamp()
            to_ts.FromSeconds(start_of_day - 1)
            getattr(req, "from").CopyFrom(from_ts)
            getattr(req, "to").CopyFrom(to_ts)
            chan = self._get_channel()
            stub = marketdata_pb2_grpc.MarketDataServiceStub(chan)
            resp = stub.GetCandles(req, metadata=self._metadata())
            listed = [self._candle_to_dict(c) for c in resp.candles]
        except Exception as e:
            logger.warning(f"[TINKOFF] prev_close fetch failed for {ticker}: {e}")
            return None
        if not listed:
            return None
        last = listed[-1]
        if last["time"] >= start_of_day:
            return None
        save_candles(meta["ticker"], "1d", [last])
        logger.info(f"[TINKOFF] Fetched prev_close={last['close']} for {meta['ticker']}")
        return last["close"]

    def get_prices(self, symbols):
        meta_by_orig = {}
        figis = []
        for s in symbols:
            try:
                meta = self._resolve(s)
            except Exception as e:
                logger.warning(f"[TINKOFF] Skip price for {s}: {e}")
                continue
            meta_by_orig[s.upper()] = meta
            figis.append(meta["figi"])
        if not figis:
            return {}
        try:
            chan = self._get_channel()
            stub = marketdata_pb2_grpc.MarketDataServiceStub(chan)
            resp = stub.GetLastPrices(
                marketdata_pb2.GetLastPricesRequest(instrument_id=figis),
                metadata=self._metadata(),
            )
        except grpc.RpcError as e:
            code = getattr(e.code(), "name", "UNKNOWN")
            logger.error(f"[TINKOFF] GetLastPrices failed ({code}): {e.details()}")
            return {}
        result = {}
        figi_to_orig = {}
        for orig, meta in meta_by_orig.items():
            figi_to_orig[meta["figi"]] = orig
        for lp in resp.last_prices:
            orig = figi_to_orig.get(lp.figi)
            if orig is None:
                continue
            meta = meta_by_orig.get(orig)
            price = _quotation_to_float(lp.price)
            prev_close = self._resolve_prev_close(meta) if meta else None
            if prev_close and prev_close > 0:
                change = price - prev_close
                change_pct = change / prev_close * 100.0
            else:
                change = None
                change_pct = None
            result[orig] = {
                "price": price,
                "change": change,
                "changePct": change_pct,
            }
        return result

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    @staticmethod
    def _candle_to_dict(c):
        return {
            "time": c.time.seconds,
            "open": _quotation_to_float(c.open),
            "high": _quotation_to_float(c.high),
            "low": _quotation_to_float(c.low),
            "close": _quotation_to_float(c.close),
            "volume": int(c.volume),
        }


ModuleRegistry.register_data_source(TinkoffSource)