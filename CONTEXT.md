# PROJECT CONTEXT (сжатый)

## Куда что идёт
- **Рабочая папка:** `E:\NOW\tinminal` — здесь разрабатываем и запускаем сервер (`run.bat`, адрес http://localhost:5000).
- **Remote:** https://github.com/jordan23bull-afk/tinminal , ветка `main`. Автор коммитов: jordan23bull-afk (email настроен локально в репо).
- **`E:\deepseek\local-trading-dashboard`** — исследуемая копия, **не трогать, ничего не коммитить** без явной просьбы.
- Коммитить/пушить только по явному запросу пользователя. Секреты (`candles.db*`, `backend/token.txt`, `backend/certs/`, `settings.json`, `*.bak*`) — в `.gitignore`, никогда не пушить.

## Проект
Local Market Dashboard: дашборд M1-свечей MOEX через Tinkoff Invest API (gRPC поток + REST), Flask+Socket.IO, фронт — ES-модули + Lightweight Charts.

## Проделанные фиксы (актуальное состояние кода)
1. **Проценты в watchlist** (`backend/data_sources/tinkoff_source.py`): `_resolve_prev_close()` — сначаla локальный кэш, при промахе `_fetch_prev_close()` тянет последнюю закрытую дневную свечу по `GetCandles` и сохраняет её в кэш (SQLite). In-memory кэш по figi (TTL 1ч).
2. **Зелёные тикеры в watchlist** (`frontend/js/app.js`): в `syncTickerSubscriptions()` при отписке лишней комнаты добавлен `setTickerStatus(sub.symbol, "idle")` — снимает класс `wl-live`.
3. **Перезапуск gRPC-стрима при смене тикера/таймфрейма** (`tinkoff_source.py`): стрим сбрасывается через idle-грацию. `unsubscribe_realtime` больше НЕ ставит `_stream_stop` при пустом `_wanted` — ставит `_empty_since = time.monotonic()`. `_stream_loop` каждые 2с проверяет idle: если `_wanted` пуст дольше `STREAM_IDLE_TIMEOUT = 30.0` — стоп; новый subscribe сбрасывает. `_ensure_stream` пересоздаёт поток только если thread мёртв.
4. **TLS**: gRPC к Tinkoff требует `backend/certs/tinkoff-national-ca.pem` (Russian Trusted Root CA, публичный сертификат) — без него `CERTIFICATE_VERIFY_FAILED`. Файл НЕ в git (certs в .gitignore) — при клоне надо копировать вручную или решить (пользователь не разрешал коммитить). В `E:\NOW\tinminal\backend\certs\` он есть; `ca-bundle.pem` сгенерирован `core/tls.py`.
5. **PR «оптимизация-ресурсов»** смерджен (коммит a66ff41 + merge 74aa430). Он:
   - сломал доставку live-графику: `async_mode="eventlet"` в `backend/core/app.py` → **исправлено локально на `"threading"`** (не закоммичено!);
   - добавил `flask-limiter` в requirements (оставлен), `eventlet` из requirements **удалён**;
   - переписал `.gitignore` (мои правила уже восстановлены);
   - код-изменения (database/registry/tinkoff_source/app) сохранены.
6. **История git вычищена** (`git filter-repo`): из всех коммитов удалены `candles.db`, `backend/token.txt`, `backend/certs/`. Force-push сделан. Файл `candles.db` в репозитории НЕ существует и не должен появляться.

## Новый индикатор «Din POC» (добавлен, не коммичен)
В `frontend/js/indicators.js`:
- `INDICATOR_TYPES` + `mergeIndicators()` builtins — добавлена запись `din_poc` (label «Din POC», params: period=50, bins=30; extra: color #00C2FF, lineWidth 2).
- `calcDinPoc(slice, numBins)` — профиль объёма: объём каждой свечи распределяется по корзинам диапазона H–L пропорционально перекрытию (вариант 4 техники), POC = центр корзины с макс. объёмом.
- В `calcIndicator` ветка `if (indId === "din_poc" || custom.type === "din_poc")` — динамическое окно из последних N баров.
- В `frontend/js/chart-manager.js` `HEAVY_INDICATOR_TYPES` добавлен `"din_poc"` (пересчёт только на закрытых свечах).
- Пользователь видит индикатор после F5 (фронт — статика, рестарт бэкенда не нужен).

## Открытые вопросы / TODO
- Пользователь не подтвердил, коммитить ли `tinkoff-national-ca.pem` в репозиторий (рекомендую — иначе чистые клоны падают по TLS). Спросить при случае.
- PR-изменения и правки `app.py` (threading) и DIN POC — ещё не закоммичены в `E:\NOW\tinminal`.
- Возможный рефактор POC `extendMode=cross` «застревает» при гэпах (не приоритет — есть Din POC).
- **Две вкладки / два компа:** `localStorage` и `settings.json` общий для всех подключений. `saveState()` перезаписывает ключ — вторая вкладка/комп теряет свои тикеры. При мульти-браузере серверный бэкап (`storage.js`) не перезаписывает локальные данные (загружает только отсутствующие ключи) — данные дивергентны. Не решено.
- **Залип prev_close в watchlist (PLZL):** `_resolve_prev_close()` первым делом проверяет in-memory кэш `_prev_close_cache[figi]` (TTL 1ч). На живом сервере он закэшировал мусор `1309.2` (гонка двойного debug-reloader процесса при старте) — вочлист показывал PLZL −19% вместо реальных ≈ +0.26%. Свежий инстанс источника даёт правильное `1056.8`; `_fetch_prev_close` (DAY limit=1) тоже детерминированно возвращает 1055.2. Проявления — только у PLZL, остальные тикеры коррент. Решение: перезапуск сервера (сброс кэша) + желательно стартовать с `FLASK_DEBUG=0`, чтобы не было двух процессов-гонщиков. Файл: `backend/data_sources/tinkoff_source.py:478` (`_resolve_prev_close`).
- **[РЕШЕНО] «Cannot invoke RPC on closed channel» → 500 в /api/prices:** `_stream_loop` использовал **общий** history-канал (`_get_channel()`) для live-стрима и в `finally` вызывал `channel.close()` — при idle-stop стрима убивался канал для `/api/prices` и `/api/history`. Исправлено: поток теперь делает **отдельный канал** `_get_stream_channel()` (свой за id), а закрытие стрим-канала не трогает кэш истории (добавлена защита `if self._channel_cache is channel: _channel_cache=None`). Файл: `backend/data_sources/tinkoff_source.py`.
- **Двойной процесс сервера:** сервер стартует как reloader-супервизор + worker (2 python-процесса) даже при `use_reloader=False` в `socketio.run` (задано в `app.py`). Не мешает работе, но гонка при старте может порождать мусорный кэш (см. PLZL). Точная причина не определена; оставлено.

## Проверка кода
`node --check frontend/js/*.js` и `python -m py_compile backend/core/*.py` — базовые синтаксические проверки.

## Запуск
`run.bat` в `E:\NOW\tinminal` (venv уже создан, зависимости стоят). Убедиться, что `backend/certs/tinkoff-national-ca.pem` на месте.