# Local Trading Dashboard

Локальный дашборд для отображения M1-свечей биржевых инструментов (MOEX) и их анализа в реальном времени.

Проект полностью мигрировал с MOEX ISS (REST polling) на **Tinkoff Invest API** (gRPC WebSocket-push + REST). Тинкеры — динамическая сущность: любой инструмент резолвится в рантайме через `FindInstrument`, подписки живут на одном WebSocket-канале, а сами тикеры хранятся в localStorage пользователя.

---

## Содержание

1. [Обзор](#обзор)
2. [Архитектура](#архитектура)
3. [Стек технологий](#стек-технологий)
4. [Структура проекта](#структура-проекта)
5. [Модель данных и поток свечей](#модель-данных-и-поток-свечей)
6. [Бэкенд](#бэкенд)
   - [Ядро (core)](#ядро-core)
   - [Источники данных (data_sources)](#источники-данных-data_sources)
   - [API endpoints](#api-endpoints)
   - [WebSocket / Socket.IO события](#websocket--socketio-события)
7. [Фронтенд](#фронтенд)
   - [Модули JS](#модули-js)
   - [Жизненный цикл тикера](#жизненный-цикл-тикера)
   - [Индикаторы](#индикаторы)
   - [Раскладки](#раскладки)
8. [Хранилище состояния](#хранилище-состояния)
9. [Установка и запуск](#установка-и-запуск)
10. [Настройка](#настройка)
11. [Безопасность](#безопасность)
12. [Обработка ошибок и отказоустойчивость](#обработка-ошибок-и-отказоустойчивость)
13. [Критерии готовности (чек-лист)](#критерии-готовности-чек-лист)
14. [Расширение проекта](#расширение-проекта)
15. [Известные ограничения](#известные-ограничения)

---

## Обзор

До переезда данные тянулись HTTP-поллингом с `iss.moex.com`: последняя свеча была неточной, долгой и кэшировалась на стороне MOEX. Теперь:

- **Live-свечи** приходят по **gRPC streaming** от Tinkoff (`MarketDataStream`), свежая свеча обновляется через `candleSeries.update()` без перерисовки графика.
- **История** для первичной отрисовки запрашивается по REST `GetCandles`.
- **Инструмент** ищется по тикеру через `FindInstrument` (никаких захардкоженных FIGI).
- **Один WebSocket-канал** обслуживает все активные тикеры.
- **Тикеры** пользователь добавляет/удаляет без перезагрузки страницы; список активных тикеров переживает перезагрузку (localStorage + серверный `settings.json`).

---

## Архитектура

```
Browser (frontend)
  ├─ index.html + css/ (Layout: Flaxbox/Grid)
  ├─ js/
  │   ├─ app.js            — оркестрация: charts, watchlist, settings, layouts
  │   ├─ ws-client.js      — Socket.IO клиент, реестр подписок
  │   ├─ chart-manager.js  — создание/обновление графиков Lightweight Charts
  │   ├─ chart-ui.js       — хидер графика, dropdown'ы, индикаторы, контекстное меню
  │   ├─ layout-manager.js — сетки раскладок 1..12 графиков
  │   ├─ indicators.js     — встроенные и пользовательские индикаторы
  │   ├─ tickers.js        — реестр тикеров (localStorage)
  │   ├─ storage.js        — автосинк localStorage → settings.json
  │   └─ utils.js          — вспомогательные функции
  └─ websocket (Socket.IO)
          │
          ▼
Backend (Flask + Flask-SocketIO)
  ├─ core/
  │   ├─ app.py            — HTTP API + Socket.IO хуки, менеджер активных потоков
  │   ├─ interfaces.py     — абстракции IDataSource / IIndicator
  │   ├─ registry.py       — реестр источников/индикаторов
  │   ├─ database.py       — SQLite-кэш свечей (thread-local, WAL)
  │   └─ tls.py            — сборка CA-бандла для gRPC/TLS
  └─ data_sources/
       ├─ tinkoff_source.py  — Tinkoff Invest API (gRPC, основной источник)
       └─ moex_source.py     — legacy MOEX ISS (оставлен, но отключён от цепочки)
```

**Ключевой поток данных:**

```
Пользователь вводит тикер (или кликает в watchlist)
   → POST /api/history  (резолв инструмента → GetCandles → SQLite-кэш → setData)
   → ws.subscribe (symbol, tf)  → backend подписывает Tinkoff MarketDataStream на (figi, interval)
   → Свеча пришла в stream → broadcast в комнату "SYMBOL_TF"
   → frontend ws-client получает candle_update → candleSeries.update()
```

---

## Стек технологий

### Бэкенд

| Слой | Технология |
|---|---|
| HTTP/WS сервер | Python 3.10+, Flask, Flask-SocketIO (async_mode=`threading`) |
| CORS | flask-cors (открыт для любых origins — только локальный прототип) |
| API Tinkoff | gRPC (`invest-public-api.tinkoff.ru:443`), пакет `tinkoff.invest.grpc` (сгенерированные стубы в `gen/`) |
| Кэш | SQLite (`candles.db`), WAL, thread-local соединения, PK `(symbol, timeframe, time)` |
| TLS | Всегда свежий CA-бандл `certs/ca-bundle.pem` из certifi + сертификат Тинькофф |

Зависимости: `backend/requirements.txt` — flask, flask-cors, flask-socketio, requests, grpcio, grpcio-tools, protobuf.

### Фронтенд

| Слой | Технология |
|---|---|
| Графики | Lightweight Charts (standalone production build, локальный файл) |
| WebSocket | Socket.IO client (локальный `socket.io.min.js`, транспорты websocket+polling) |
| Модули | ES modules (`<script type="module">`), без сборщика |
| Хранение | localStorage + автосинк на сервер |

---

## Структура проекта

```
local-trading-dashboard/
├─ backend/
│  ├─ core/
│  │  ├─ app.py            — точка входа, HTTP API, Socket.IO
│  │  ├─ database.py       — SQLite-кэш свечей
│  │  ├─ interfaces.py     — интерфейсы источников и индикаторов
│  │  ├─ registry.py       — реестр модулей
│  │  └─ tls.py            — CA-бандл для gRPC
│  ├─ data_sources/
│  │  ├─ tinkoff_source.py — основной источник (Tinkoff gRPC)
│  │  └─ moex_source.py    — legacy источник (MOEX ISS, отключён)
│  ├─ gen/tinkoff/invest/grpc/ — сгенерированные protobuf-стубы
│  ├─ certs/               — CA-сертификаты
│  ├─ requirements.txt
│  └─ token.txt            — API-токен Tinkoff (не коммитить!)
├─ frontend/
│  ├─ index.html
│  ├─ css/                 — themes, layout, toolbar, sidebar
│  ├─ js/                  — app, ws-client, chart-manager, chart-ui, ...
│  └─ sounds/alert.wav     — звук алерта
├─ candles.db              — SQLite-кэш (генерируется)
├─ settings.json           — серверный бэкап localStorage
├─ run.bat                 — запуск на Windows
├─ run.sh                  — запуск на Linux/macOS
└─ README.md
```

---

## Модель данных и поток свечей

### Формат свечи

Свеча **всегда в UTC** (эпоха, секунды), цены — числа:

```json
{
  "time": 1786456800,
  "open": 286.84,
  "high": 286.85,
  "low": 286.84,
  "close": 286.85,
  "volume": 13918
}
```

Правила, которыми руководствуется весь пайплайн:

- `time` — строго UTC epoch (секунды). Никаких локальных таймзон в данных.
- Цены — только числа (`float`), строки запрещены.
- Дубли свечей на одно и то же `time` проверяются по PK в SQLite и гасятся на фронтенде (`update()` перезаписывает свечу с тем же временем).
- `setData()` разрешён только при первичной отрисовке истории; live-обновление — только `update()` (никакой полной перерисовки).

### Поддерживаемые таймфреймы

| tf | Tinkoff interval |
|---|---|
| 1m | CANDLE_INTERVAL_1_MIN |
| 5m, 10m, 15m, 30m | соответствующие интервалы |
| 1h, 2h, 4h | Hour / 2_HOUR / 4_HOUR |
| 1d | DAY |

Графики в UI по умолчанию используют набор `1m / 10m / 1h / 1d`, но Tinkoff-источник поддерживает все перечисленные.

---

## Бэкенд

### Ядро (core)

#### `core/interfaces.py`

Абстракции, на которых строится расширяемость:

```python
class IDataSource(ABC):
    name, supported_timeframes
    get_historical_data(symbol, timeframe, limit) -> list[candle]
    subscribe_realtime(symbol, timeframe, callback) -> bool
    unsubscribe_realtime(symbol, timeframe) -> bool

class IIndicator(ABC):
    name, parameters, output_schema
    calculate(candles, params) -> dict[str, list[point]]
```

#### `core/registry.py`

`ModuleRegistry` автоматически загружает все модули из `data_sources/` по суффиксу `.py`, регистрирует классы-наследники `IDataSource`/`IIndicator` и отдаёт синглтоны через `get_data_source(name)` / `get_indicator(name)`.

#### `core/database.py` — кэш свечей

- SQLite `candles.db` с `PRAGMA journal_mode=WAL`, `synchronous=NORMAL`.
- Соединение на поток (`threading.local`), поэтому многопоточные stream-threads не конкурируют за одну коннекцию.
- Таблица `candles(symbol, timeframe, time, open, high, low, close, volume)` с PK `(symbol, timeframe, time)` — `INSERT OR REPLACE` даёт идемпотентность на одном таймстэмпе.
- Политика чтения: история сначала берётся из БД; если данные свежие (`MAX(time)` не старше 5 минут) — кэш отдаётся мгновенно, иначе фетчится с Tinkoff и сохраняется.

#### `core/tls.py`

Собирает `certs/ca-bundle.pem` = certifi + `tinkoff-national-ca.pem`, выставляет env `REQUESTS_CA_BUNDLE` / `SSL_CERT_FILE` / `GRPC_DEFAULT_SSL_ROOTS_FILE_PATH`. gRPC использует бандл напрямую через `root_certificates_bytes()`.

#### `core/app.py` — сервер

- Flask + CORS (открыт) + Socket.IO (`threading`).
- Раздаёт `frontend/` статикой.
- **Единый источник правды по потокам:** `active_streams` (множество комнат `SYMBOL_TF`) и `client_rooms[sid]` в `threading.Lock`.
- Комната = `f"{symbol}_{timeframe}"`. Один активный поток на комнату, сколько бы клиентов в ней ни было. Последний клиент, покинувший комнату, гасит поток (`unsubscribe_realtime`).
- Источник по умолчанию — `tinkoff`. Цепочки fallback на MOEX **удалены** — ошибки Tinkoff (невалидный токен, тикер не найден и т.д.) всплывают наружу как `ticker_error`.

### Источники данных (data_sources)

#### `data_sources/tinkoff_source.py` — основной источник

Полноценный менеджер тикеров на одном gRPC-стриме:

- **Резолв инструмента**: `FindInstrument(query=ticker)` → выбор кандидата с приоритетом (тип инструмента, `api_trade_available_flag`, точное совпадение ticker). Возвращает `figi`, `instrument_uid`, `name`, `currency`, `lot`, `instrument_type`. Результат кэшируется в `self._instruments`.
  > Замечание: `FindInstrument` возвращает `InstrumentShort` (без поля `currency`) — поле читается через `getattr` с дефолтом `"rub"`.
- **История**: `GetCandles(instrument_id=figi, interval, from, to, limit≤1000)` с проверкой SQLite-кэша.
- **Live**: один `MarketDataStream` на всех. Таблицы:
  - `_wanted[(symbol, tf)] -> (figi, interval)` — что хочет клиент;
  - `_callbacks[(symbol, tf)] -> callback`;
  - `_by_wire[(figi, interval)] -> set[(symbol, tf)]` — маппинг wire → ключи;
  - `_last_sent` — что уже отправлено в stream (для diff-синка подписок);
  - `_last_time[(figi, interval)]` — последнее время свечи для ресинка.
- **Синк подписок**: `_sync_plan()` сравнивает `_last_sent` с желаемым набором и шлёт `SUBSCRIPTION_ACTION_SUBSCRIBE/UNSUBSCRIBE`.
- **Ресинк после reconnect**: `_resync_missed()` после восстановления стрима дотягивает пропущенные свечи через `GetCandles` от `last_time` до «сейчас» и рассылает их в колбэки (закрывает разрывы).
- **Цены** watchlist: `GetLastPrices(instrument_id=[...])`.

Обработка gRPC-ошибок: `UNAUTHENTICATED` → `PermissionError("token is invalid")`; `RESOURCE_EXHAUSTED` → rate limit message; иначе `ConnectionError`.

#### `data_sources/moex_source.py` — legacy (не используется в цепочке)

Оставлен как справочный/запасной. Работал через REST поллинг `iss.moex.com` с własnym определением доски (TQBR/FORTS/INDEX) и почасовой эвристикой прошлых свечей. В `get_source_chain` не входит — live-потоки Tinkoff не фолбэчатся на MOEX.

### API endpoints

| Метод | Путь | Описание |
|---|---|---|
| GET | `/` | index.html |
| GET | `/<path>` | статика из frontend/ |
| GET | `/api/health` | статус + список источников и индикаторов |
| GET | `/api/sources` | `{"sources": ["tinkoff", "moex"]}` |
| GET | `/api/indicators` | метаданные индикаторов (params/output_schema) |
| GET/POST | `/api/settings` | серверный бэкап localStorage (лимит 10MB) |
| POST | `/api/history` | история свечей + рассчитанные индикаторы |
| GET | `/api/prices?symbols=SBER,GAZP&source=tinkoff` | актуальные цены |

`/api/history` request body:

```json
{
  "source": "tinkoff",
  "symbol": "SBER",
  "timeframe": "1m",
  "limit": 500,
  "indicators": { "sma": { "period": 20 } }
}
```

response:

```json
{
  "symbol": "SBER",
  "timeframe": "1m",
  "source": "tinkoff",
  "candles": [ { "time": ..., "open": ..., "high": ..., "low": ..., "close": ..., "volume": ... } ],
  "indicators": { "sma": [ { "time": ..., "value": ... } ] }
}
```

### WebSocket / Socket.IO события

**Client → Server:**

| Событие | Payload | Действие |
|---|---|---|
| `connect` | — | регистрация client_rooms |
| `subscribe` | `{symbol, timeframe, source}` | join комнату, при первом клиенте — подписка на Tinkoff stream |
| `unsubscribe` | `{symbol, timeframe, source}` | leave комнату, при последнем — отписка потока |

**Server → Client:**

| Событие | Payload | Смысл |
|---|---|---|
| `status` | `{msg}` | подключение установлено |
| `subscribed` | `{room, symbol, timeframe, source}` | подписка активна (статус тикера → live) |
| `candle_update` | `{symbol, timeframe, candle}` | live-свеча для комнаты |
| `ticker_error` | `{symbol, msg}` | ошибка тикера (статус → error) |
| `error` | `{msg}` | общая ошибка |

При `disconnect` сервер автоматически отписывает и гасит потоки последнего клиента каждой комнаты.

---

## Фронтенд

### Модули JS

#### `js/utils.js`
`generateId()` (уникальные id графиков), `log()`.

#### `js/ws-client.js`
Инкапсулирует Socket.IO:
- `subscribe(symbol, tf, source)` — кладёт комнату в `subscriptions` (Map) и шлёт, если соединение живо;
- `unsubscribe(...)` — удаляет из реестра и шлёт `unsubscribe`;
- `_resubscribeAll()` — после reconnect переотправляет **все** активные подписки (восстановление после обрыва);
- буферизация свечей (`_pendingUpdates` + flush 16ms);
- события: `candleUpdate`, `statusChange`, `subscribed`, `tickerError`.

#### `js/app.js`
Оркестратор:
- авто-коннект WS; на reconnect — автоматический ресабскрайб всех активных комнат;
- watchlist: render, фильтры, флаги, удаление тикера (**с отпиской WS и удалением графиков/серий**), `syncTickerSubscriptions()` — вычищает лишние подписки, если тикер больше не отображается;
- `loadHistory()` — история → `setData()` + подписка на live;
- раскладки (1–12 графиков) с синком символа/интервала/перекрестия;
- статусы тикера: **loading → live/error** (классы `wl-loading/wl-live/wl-error` в watchlist);
- цена и изменение % в watchlist (/api/prices, обновление каждые 5с + при возврате вкладки);
- сохранение/восстановление полного состояния в localStorage.

#### `js/chart-manager.js`
Всё про графики Lightweight Charts:
- `createChart(id, config)` — хидер, серия, гистограмма объёмов, resize observer, синк кроссхейра;
- `updateData()` — `setData` истории (+ пересчёт индикаторов, сохранение зума);
- `updateCandle()` — только `update()` последней свечи (без перерисовки);
- типы графиков: candlestick, line, area, bar;
- горизонтальные линии/алерты (price line + уведомления + звук `sounds/alert.wav`).

#### `js/chart-ui.js`
Хидер графика: выбор символа (точный ввод по Enter + поиск по watchlist), таймфрейм, тип графика, кнопки индикаторов, настройки цветов, контекстное меню линий (изменить/алерт/удалить).

#### `js/indicators.js`
Встроенные: SMA, EMA, RSI, MACD, WMA, Stochastic, POC (хотительный профиль по дням, `extendMode: day/cross`), POC_day. Пользовательские — через формулу на JS (проверяется `new Function` при сохранении). Индикаторы хранятся в localStorage, можно удалять.

#### `js/layout-manager.js`
Сетки: 1/2/3/4/6/9/12 графиков, у 2 и 3 — несколько ориентаций. `autoLayout()` подбирает раскладку по числу графиков.

#### `js/tickers.js`
Реестр тикеров (единый источник правды на клиенте):
- seed-список популярных акций MOEX на первый запуск;
- сохранение в localStorage `trading-dashboard-tickers`;
- детект типа бумаги (TQBR/FORTS/INDEX) для группировки watchlist;
- флаги цветовых списков.

#### `js/storage.js`
Перехватывает `localStorage.setItem`, дебаунс 500мс → отправляет весь localStorage на `POST /api/settings`. При старте загружает недостающие ключи с сервера.

### Жизненный цикл тикера

**Добавление тикера:**
1. Пользователь вводит тикер (поле/поиск) → `loadHistory()`.
2. `POST /api/history`: резолв `FindInstrument` → `GetCandles` → кэш → `setData()`.
3. `setTickerStatus(symbol, "loading")` → подписка `ws.subscribe`.
4. Сервер возвращает `subscribed` → статус **live**.
5. Далее только `update()` на каждую свечу.

**Удаление тикера (кнопка 🗑 в watchlist):**
1. Для всех графиков с этим тикером: `ws.unsubscribe` + `chartManager.removeChart(id)`.
2. `removeTicker` из реестра localStorage.
3. `syncTickerSubscriptions()` — убедиться, что лишних подписок не осталось.
4. Последний клиент комнаты на сервере гасит gRPC-стрим для этого инструмента.

### Индикаторы

Кнопки на хидере. Пересчитываются на клиенте из `_lastCandles` при каждом live-обновлении. Пользовательский индикатор — набор `type + params + formula`; формула выполняется в песочнице `new Function` с доступом к `candles/closes/highs/lows/volumes/prev/emaCalc`; синтаксис валидируется тестовым прогоном перед сохранением.

### Раскладки

Кнопка компоновки в тулбаре. Синхронизация между графиками (галочки): инструмент, интервал, перекрестие, время, диапазон дат. При смене раскладки состояние линий/алертов мигрирует на новые графики.

---

## Хранилище состояния

| Ключ localStorage | Содержимое |
|---|---|
| `trading-dashboard-tickers` | реестр тикеров |
| `trading-dashboard-flags` | цветовые флаги |
| `trading-dashboard-state` | раскладка, символы, таймфреймы, индикаторы, линии |
| `chart-settings-<SYMBOL>` | цвета графика |
| `trading-dashboard-custom-indicators` | пользовательские индикаторы |
| `trading-alerts` | алерты (устаревают через 7 дней) |
| `trading-dashboard-wl-columns` | ширины колонок watchlist |

При каждом `setItem` данные дублируются на сервер в `settings.json`; при загрузке страницы недостающие ключи восстанавливаются с сервера. Так состояние переживает очистку localStorage.

---

## Установка и запуск

### Windows

```bat
run.bat
```

Скрипт: проверяет `TINKOFF_TOKEN` → создаёт venv → ставит requirements → запускает сервер на `http://localhost:5000`.

### Linux / macOS

```bash
chmod +x run.sh
./run.sh
```

> `run.sh` сейчас всегда пересоздаёт venv и переустанавливает зависимости (заметно медленнее). Для повторного запуска можно запускать напрямую: `backend/venv/bin/python backend/core/app.py`.

### Вручную

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python core/app.py
```

Открыть `http://localhost:5000`.

---

## Настройка

### API-токен Tinkoff

Требуется read-only токен. Два способа:

1. Переменная окружения:
   ```bash
   export TINKOFF_TOKEN=your_token    # Linux/macOS
   set TINKOFF_TOKEN=your_token       # Windows
   ```
2. Файл `backend/token.txt` (одна строка, без переносов и пробелов).

Токен читается при каждом запросе/подписке. Без токена источник падает с `ValueError` и понятным сообщением.

### settings.json

Файл генерируется автоматически из localStorage. При необходимости можно посеять начальные значения (например флаги) руками в формате `{"<key>": "<value>"}`.

---

## Безопасность

- **Токен не хранится во фронтенде** — только на бэкенде, в env или `backend/token.txt`. Для продакшена добавляется backend-proxy.
- `backend/token.txt` должен быть в `.gitignore` (рекомендуется исключить из VCS).
- gRPC — только TLS (`:443`), используется верифицированный CA-бандл (`certs/ca-bundle.pem`).
- CORS открыт полностью (`*`) — приемлемо только для локального личного прототипа. Для публичного развёртывания — ограничить origins.
- Рекомендуется минимально возможные права токена (только рыночные данные / чтение инструментов).

---

## Обработка ошибок и отказоустойчивость

| Ситуация | Поведение |
|---|---|
| Токен невалиден / отсутствует | `PermissionError`/`ValueError`, бэкенд шлёт `ticker_error`, тикер в статусе **error** |
| Тикер не найден | `FindInstrument` → ValueError, UI показывает **error**, подписка не создаётся |
| Ошибка REST / gRPC | логируется, кэш из SQLite служит фолбэком, если свежий |
| Обрыв WebSocket (клиент) | Socket.IO `reconnection`, `_resubscribeAll()` переподписывает все активные тикеры |
| Обрыв gRPC-стрима (бэкенд) | `_stream_loop` переподключается с экспоненциальным бэкоффом (1→15с), `_last_sent` сбрасывается → полный ресабскрайб, `_resync_missed()` дотягивает пропущенные свечи |
| Empty history | `/api/history` возвращает пустой массив; график просто пустой, live-подписка продолжает работать |
| Rate limit | Tinkoff `RESOURCE_EXHAUSTED` → понятное сообщение об ошибке |
| Инструмент недоступен для торговли | выбор кандидата при резолве отдаёт приоритет инструментам с `api_trade_available_flag` |

---

## Критерии готовности (чек-лист)

- [x] Пользователь может добавить произвольный тикер
- [x] Пользователь может удалить тикер (с отпиской WS и удалением графика/серий)
- [x] Нет захардкоженных тикеров/FIGI — всё резолвится в рантайме
- [x] Графики создаются и удаляются динамически (1–12 раскладки)
- [x] Live-свечи обновляются без скачков и без полной перерисовки (только `update()`)
- [x] После перезагрузки страницы активные тикеры восстанавливаются (localStorage + settings.json)
- [x] После обрыва WebSocket подписки восстановились автоматически + ресинк пропущенных свечей
- [x] Время свечей — UTC
- [x] Последняя свеча обновляется плавно
- [x] Интерфейс не ссылается на MOEX ISS как на источник данных

---

## Расширение проекта

### Новый источник данных

```python
# backend/data_sources/my_source.py
from core.interfaces import IDataSource
from core.registry import ModuleRegistry

class MySource(IDataSource):
    @property
    def name(self): return "my_source"
    ...

ModuleRegistry.register_data_source(MySource)
```

Модуль подхватывается автозагрузкой, появится в `/api/sources`. Для включения как дефолтного — заменить `DEFAULT_SOURCE` в `core/app.py`.

### Новый индикатор

Добавить в `frontend/js/indicators.js` в `INDICATOR_TYPES` (для билтина) или создать через UI «+». Бэкенд-индикаторы добавляются классом-наследником `IIndicator` в любом `.py` внутри папки модулей и регистрируются в реестре.

### Планы на развитие

- Backend-proxy для токена (убрать токен из процесса локально).
- Ограничение CORS под конкретный origin.
- Замена `_pendingUpdates`-буферизации на приоритет последней свечи при высокой частоте.
- Авто-детект торговых интервалов сессии (чтобы не рисовать ночные разрывы).

---

## Известные ограничения

- `run.sh` пересоздаёт venv при каждом запуске — на повторных запусках лучше бинарь напрямую (см. выше).
- `FindInstrument` отдаёт `InstrumentShort` без `currency` — валюта выставляется дефолтом `"rub"` (для MOEX приемлемо).
- Таймфреймы UI ограничены набором `1m/10m/1h/1d`, хотя источник поддерживает больше (5m/15m/30m/2h/4h). При необходимости легко добавить кнопки в `chart-ui.js` (`TIMEFRAMES`).
- Выбор кандидата при резолве не гарантирует «правильную» доску (например, для фьючерсов со сложным построением тикеров) — приоритет отдан типу и трейдуемости.
- Открытый CORS и локальное хранение токена — только для личного прототипа.
```