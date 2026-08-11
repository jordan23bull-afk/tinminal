# Local Market Dashboard

Локальный дашборд для просмотра котировок и M1-свечей биржевых инструментов (MOEX) с live-обновлением через **Tinkoff Invest API** (gRPC streaming + REST).

Тикеры резолвятся в рантайме через `FindInstrument` (никаких захардкоженных FIGI), live-свечи идут на один WebSocket-канал, актуальные тикеры переживают перезагрузку (localStorage + `settings.json`).

## Требования

- Python 3.10+
- Read-only токен Tinkoff Invest API

## Быстрый старт

### Windows

```
run.bat
```

### Linux / macOS

```
chmod +x run.sh
./run.sh
```

### Вручную

```bash
cd backend
python -m venv venv
venv\Scripts\activate      # Linux: source venv/bin/activate
pip install -r requirements.txt
python core/app.py
```

Открыть `http://localhost:5000`.

## Токен

Нужен read-only токен, один из способов:

1. `set TINKOFF_TOKEN=your_token` (Windows) / `export TINKOFF_TOKEN=your_token`
2. Файл `backend/token.txt` (одна строка)

Токен живёт только на бэкенде; `token.txt` исключён из git.

## Структура

```
backend/
  core/app.py            — HTTP API + Socket.IO, менеджер live-потоков
  core/database.py       — SQLite-кэш свечей (WAL)
  core/tls.py            — CA-бандл для gRPC
  core/registry.py       — автозагрузка источников/индикаторов
  data_sources/tinkoff_source.py — основной источник (gRPC streaming)
  data_sources/moex_source.py    — legacy MOEX ISS (отключён)
frontend/
  js/                    — ES-модули (app, ws-client, chart-manager, indicators, ...)
  index.html, css/
```

## API

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/history` | история свечей + индикаторы |
| GET | `/api/prices?symbols=SBER,GAZP` | актуальные цены и изменение % |
| GET | `/api/settings` / POST | серверный бэкап localStorage |
| GET | `/api/health` | статус, источники, индикаторы |
| WS | Socket.IO | `subscribe` / `unsubscribe` / `candle_update` / `subscribed` / `ticker_error` |

## Безопасность

- Токен только на бэкенде (env или `backend/token.txt`), во фронт не попадает.
- gRPC только TLS (проверенный CA-бандл).
- CORS открыт (`*`) — только для локального прототипа.