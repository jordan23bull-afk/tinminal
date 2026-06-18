# Local Trading Dashboard

Multi-chart market analysis app for MOEX, running on localhost.

## Features

- Multi-chart grid with lightweight-charts
- Real-time WebSocket updates
- Plugin architecture for data sources
- Dark trading theme
- Client-side indicators: RSI, MACD, SMA, Bollinger, ATR, WMA, Stochastic, POC
- Data source: MOEX ISS (live)

## Quick Start

### Windows
```bash
run.bat
```

### Linux/macOS
```bash
chmod +x run.sh
./run.sh
```

### Manual Setup
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python core/app.py
```

Open `http://localhost:5000` in your browser.

## Project Structure

```
local-trading-dashboard/
├── backend/
│   ├── core/
│   │   ├── app.py              # Flask + REST + WebSocket
│   │   ├── registry.py         # Plugin auto-registration
│   │   └── interfaces.py       # IDataSource contract
│   └── data_sources/
│       └── moex_source.py      # MOEX ISS API
├── frontend/
│   ├── index.html
│   ├── css/                    # Themes and layout
│   └── js/                     # App, ChartManager, WSClient, indicators
└── run.bat / run.sh
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| GET | /api/sources | List data sources |
| GET | /api/prices | Current prices for tickers |
| POST | /api/history | Fetch historical candles |

## Adding New Data Sources

1. Create a new Python file in `backend/data_sources/`
2. Implement `IDataSource` interface
3. Call `ModuleRegistry.register_data_source()` at module level
4. Restart the server — auto-discovered on startup
