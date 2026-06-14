# Local Trading Dashboard

Modular offline web application for multi-chart market analysis, similar to TradingView but working entirely on localhost.

## Features

- Multi-chart grid with lightweight-charts (TradingView)
- Real-time WebSocket updates
- Plugin architecture for data sources and indicators
- Dark trading theme
- Built-in indicators: RSI, MACD, SMA
- Data sources: Mock (testing), Binance (live)

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

Open `frontend/index.html` in your browser.

## Project Structure

```
local-trading-dashboard/
├── backend/
│   ├── core/
│   │   ├── app.py              # Flask + REST + WebSocket
│   │   ├── registry.py         # Plugin auto-registration
│   │   └── interfaces.py       # IDataSource, IIndicator contracts
│   ├── data_sources/
│   │   ├── mock_source.py      # Test data generator
│   │   └── binance_source.py   # Binance API
│   ├── indicators/
│   │   ├── rsi.py              # Relative Strength Index
│   │   ├── macd.py             # MACD
│   │   └── sma.py              # Simple Moving Average
│   ├── models/
│   │   └── schemas.py          # Data classes
│   └── config/                 # JSON configs
├── frontend/
│   ├── index.html
│   ├── css/                    # Themes and layout
│   └── js/                     # App, ChartManager, WSClient
└── run.bat / run.sh
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| GET | /api/sources | List data sources |
| GET | /api/indicators | List indicators with params |
| POST | /api/history | Fetch historical candles + indicators |

## Adding New Plugins

1. Create a new Python file in `backend/data_sources/` or `backend/indicators/`
2. Implement `IDataSource` or `IIndicator` interface
3. Call `ModuleRegistry.register_*()` at module level
4. Restart the server — auto-discovered on startup
