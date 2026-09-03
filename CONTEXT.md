# PROJECT CONTEXT (сжатый)

## Куда что идёт
- **Рабочая папка:** `E:\NOW\tinminal` — здесь разрабатываем и запускаем сервер (`run.bat`, http://localhost:5000).
- **Remote:** https://github.com/jordan23bull-afk/tinminal , ветка `main`. Автор коммитов: jordan23bull-afk (email настроен локально).
- **`E:\deepseek\local-trading-dashboard`** — исследуемая копия, **не трогать/не коммитить** без явной просьбы.
- Коммитить/пушить только по явному запросу. Секреты (`candles.db*`, `backend/token.txt`, `backend/certs/`, `settings.json`, `*.bak*`) — в `.gitignore`, никогда не пушить.
- `async_mode="threading"` в `backend/core/app.py` — закоммичено (add820a).

## Проект
Local Market Dashboard: дашборд M1-свечей MOEX через Tinkoff Invest API (gRPC поток + REST), Flask+Socket.IO, фронт — ES-модули + Lightweight Charts.

## Последние сессии (закоммичено и запушено)
- **`9a215c5` «auto min/max level + alerts from ATR scan, fix 4h/2h/1d history»**:
  - `atr_scanner.py` — в результат добавлены `high`/`low` дневной свечи.
  - `chart-manager.js` — реестр авто-уровней `autoLevels` (localStorage `trading-auto-levels`), методы `setAutoLevels`/`applyAutoLevelsForSymbol`/`_addSymbolAlert`/`clearAllForSymbol`. Алерты ставятся даже без открытого графика (`chartId:null`). Скринерный сработавший алерт → серый.
  - `app.js` — обработчик скана ставит линии+алерты на отобранные тикеры; `clearAllForSymbol` снимает скринерное (ручные не трогает); скринерные флаги `trading-scan-flags` + `clearStaleScanFlags`; `loadHistory` зовёт `applyAutoLevelsForSymbol`+`restoreAlertColors`.
  - `tinkoff_source.py` — фикс 4h/2h/1d: `lookback` ограничен (1 год) + retry-цикл при `INVALID_ARGUMENT` (30014) окно вдвое уменьшается. Без этого запрос `4h` с `limit=3000` падал 500.
- **`8ae9f1b` «evening session levels, clear-all button, notification opens ticker window»**:
  - `atr_scanner.py` — функция `_fetch_evening_session(date, secid)` (часовые свечи MOEX, МСК, бары с 19:00 до закрытия) → поля `evening_high`/`evening_low` в результате.
  - `chart-manager.js` — `setAutoLevels` теперь хранит `{dayHigh,dayLow,eveHigh,eveLow}`; дневные уровни красные `#e53935`, вечерние жёлтые `#FFEB3B`; активный (заряженный) алерт — оранжевый `#FF9800`; сработавший сканерный сохраняет свой цвет (красный/жёлтый), ручной — серый `#9e9e9e`. `checkAlerts` красит по `alert.lineColor` для `auto`. Метод `clearAllScannerData()` + `_alertUrl()`.
  - `app.js` — кнопка «Очистить все» (`clear-all-btn`): чистит все линии/алерты/уровни/флаги (вкл. `trading-dashboard-flags`, `trading-scan-flags`) на всех тикерах в памяти, localStorage и на диске (через `flushNow`). Стартовый блок: если URL `?symbol=&timeframe=` — грузит этот тикер (ТФ по умолчанию **5m**). Уведомление открывает новое окно с тикером.
  - `index.html` — кнопка `clear-all-btn` (корзина) слева от сканера.
  - `storage.js` — экспорт `flushNow()` (принудительная синхронизация `/api/settings`).

## Поведение уровней/алертов (важно)
- Активный алерт (не сработал) — **оранжевый** `#FF9800` (все, и ручные, и сканерные).
- Сработавший сканерный — сохраняет свой цвет (**дневка красная, вечерка жёлтая**).
- Сработавший ручной — **серый** `#9e9e9e`.
- Очистка различает: ручные уровни отдельно от сканерных.

## Базовые фиксы (актуальное состояние кода)
1. **Проценты в watchlist** (`tinkoff_source.py`): `_resolve_prev_close()` — локальный кэш, при промахе `_fetch_prev_close()` тянет последнюю закрытую дневную свечу по GetCandles и кэширует (SQLite) + in-memory кэш по figi TTL 1ч.
2. **Зелёные тикеры** (`app.js syncTickerSubscriptions`): при отписке лишней комнаты `setTickerStatus(sub.symbol, "idle")` — снимает `wl-live`.
3. **Перезапуск gRPC-стрима**: idle-грация (`STREAM_IDLE_TIMEOUT=30.0`), `_ensure_stream` пересоздаёт поток только если thread мёртв.
4. **Изолированный стрим-канал** (`tinkoff_source.py`): live-стрим на отдельном `_get_stream_channel()`, закрытие не трогает history-канал (защита `_channel_cache`) — чинит «Cannot invoke RPC on closed channel».
5. **TLS**: нужен `backend/certs/tinkoff-national-ca.pem` (публичный сертификат, НЕ в git). При чистом клоне копировать вручную, иначе `CERTIFICATE_VERIFY_FAILED`. `ca-bundle.pem` генер. `core/tls.py`.

## Открытые вопросы / TODO
- Коммитить ли `tinkoff-national-ca.pem`? Не подтверждено (отдельно стоит спросить при случае).
- **Две вкладки/два компа:** `localStorage`+`settings.json` общий; `saveState()` перезаписывает ключ → вторая вкладка/комп теряет свои тикеры. Мульти-браузерный бэкап (`storage.js`) грузит только отсутствующие ключи — данные дивергентны. Не решено.
- **Залип prev_close (PLZL):** `_prev_close_cache[figi]` (TTL 1ч) кэшировал мусор `1309.2` (гонка двух отдельных запусков `run.bat` — дала пару лишних процессов) — вочлист показывал −19% вместо +0.26%. Лечится рестартом сервера (+ не запускать второй `run.bat` поверх первого). `tinkoff_source.py` `_resolve_prev_close`.
- **«Двойной процесс» сервера — НОРМА (не баг).** `venv\Scripts\python.exe` на Windows — это `venvlauncher` (redirect-ланчер), который при запуске перезапускает реальный интерпретатор отдельным процессом: пара ланчер(parent, без работы) → pythoncore\python.exe(worker, делает всё). Это стандартное поведение любого venv Python 3.3+, НЕ релоадер Werkzeug (`use_reloader=False` тут ни при чём). На настоящий сервер не влияет. Починен только конфликт версий (см. ниже).
- **Python обновлён 3.14.5 → 3.14.7** (PyManager `py install -u 3.14`), venv пересоздан от реального интерпретатора `pythoncore-3.14-64`. Старый venv сохранён в `backend/venv.bak-py3145` (можно удалить). Раньше бинарники (greenlet) не грузились (`DLL load failed`) из-за конфликта двух установок 3.14 (3.14.5 PyManager vs 3.14.6 standalone) — на чистой 3.14.7 всё чисто. **eventlet/greenlet сознательно удалены** из venv (проект их не использует: `async_mode="threading"` на app.py:41).
- Возможный рефактор POC `extendMode=cross` «застревает» при гэпах (не приоритет).

## Проверка кода
`node --check frontend/js/*.js` и `python -m py_compile backend/core/*.py` — базовые синтаксические проверки.

## Запуск
`run.bat` в `E:\NOW\tinminal` (venv готов, зависимости стоят). Убедиться, что `backend/certs/tinkoff-national-ca.pem` на месте. Фронт — статика: после правок нужен **Ctrl+F5**, рестарт бэкенда только для изменений на python.
