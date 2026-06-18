import requests
import json
import sys
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

BOARDS = {
    "shares": {"engine": "stock", "market": "shares", "board": "TQBR"},
    "futures": {"engine": "futures", "market": "forts", "board": "RFUD"},
}

class MOEXScraper:
    """Scraper for MOEX ISS API to bypass CORS restrictions."""
    
    BASE_URL = "https://iss.moex.com/iss"
    
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })

    def _parse_symbol(self, symbol: str):
        if symbol.upper().startswith("FUT:"):
            return symbol[4:], "futures"
        return symbol, "shares"

    def _iss_url(self, board_type: str, ticker: str, endpoint: str) -> str:
        b = BOARDS[board_type]
        return f"{self.BASE_URL}/engines/{b['engine']}/markets/{b['market']}/boards/{b['board']}/securities/{ticker}{endpoint}"
    
    def get_candles(self, symbol: str, interval: str = "60", days: int = 30) -> List[Dict[str, Any]]:
        """
        Get historical candles for a symbol.
        
        Args:
            symbol: Trading symbol (e.g., 'SBER', 'GAZP', 'FUT:SiU6')
            interval: Candle interval in minutes ('1', '10', '60', '24' for daily)
            days: Number of days to look back
        
        Returns:
            List of candle dictionaries with OHLCV data
        """
        ticker, board_type = self._parse_symbol(symbol)
        end_date = datetime.now().strftime("%Y-%m-%d")
        start_date = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        
        url = self._iss_url(board_type, ticker, "/candles.json")
        params = {
            "from": start_date,
            "till": end_date,
            "interval": interval,
            "iss.meta": "off"
        }
        
        try:
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            if "candles" in data and "data" in data["candles"]:
                candles = []
                for row in data["candles"]["data"]:
                    if len(row) >= 6:
                        candles.append({
                            "time": row[0],
                            "open": float(row[1]),
                            "close": float(row[2]),
                            "high": float(row[3]),
                            "low": float(row[4]),
                            "volume": int(row[5])
                        })
                return candles
            return []
        except requests.RequestException as e:
            print(f"Error fetching candles for {symbol}: {e}", file=sys.stderr)
            return []
    
    def get_current_price(self, symbol: str) -> Optional[Dict[str, Any]]:
        """
        Get current price and market data for a symbol.
        
        Returns:
            Dictionary with current market data or None if unavailable
        """
        ticker, board_type = self._parse_symbol(symbol)
        url = self._iss_url(board_type, ticker, ".json")
        params = {"iss.meta": "off"}
        
        try:
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            md_data = data.get("marketdata", {})
            columns = md_data.get("columns", [])
            rows = md_data.get("data", [])
            
            if not columns or not rows:
                return None
            
            row = rows[0]
            row_dict = dict(zip(columns, row))
            
            return {
                "symbol": symbol,
                "last": row_dict.get("LAST"),
                "change": row_dict.get("LASTCHANGE"),
                "change_pct": row_dict.get("LASTTOPREVPRICE"),
                "open": row_dict.get("OPEN"),
                "high": row_dict.get("HIGH"),
                "low": row_dict.get("LOW"),
                "volume": row_dict.get("VOLTODAY"),
                "time": row_dict.get("SYSTIME")
            }
        except requests.RequestException as e:
            print(f"Error fetching price for {symbol}: {e}", file=sys.stderr)
            return None
    
    def get_securities_list(self, market: str = "shares", board: str = "TQBR") -> List[Dict[str, Any]]:
        """
        Get list of available securities.
        
        Returns:
            List of security dictionaries
        """
        url = f"{self.BASE_URL}/engines/stock/markets/{market}/boards/{board}/securities.json"
        params = {"iss.meta": "off"}
        
        try:
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            if "securities" in data and "data" in data["securities"]:
                securities = []
                columns = data["securities"].get("columns", [])
                for row in data["securities"]["data"]:
                    if len(row) >= 2:
                        sec = {}
                        for i, col in enumerate(columns):
                            if i < len(row):
                                sec[col] = row[i]
                        securities.append(sec)
                return securities
            return []
        except requests.RequestException as e:
            print(f"Error fetching securities list: {e}", file=sys.stderr)
            return []
    
    def get_market_history(self, symbol: str = None, date: str = None) -> List[Dict[str, Any]]:
        """
        Get market history for a specific date.
        
        Args:
            symbol: Trading symbol (optional, for future use)
            date: Date in YYYY-MM-DD format (defaults to today)
        
        Returns:
            List of trade records
        """
        if not date:
            date = datetime.now().strftime("%Y-%m-%d")
        
        ticker, board_type = self._parse_symbol(symbol) if symbol else (None, "shares")
        url = f"{self.BASE_URL}/history/engines/stock/markets/shares/boards/TQBR/securities.json"
        params = {
            "date": date,
            "iss.meta": "off"
        }
        
        try:
            response = self.session.get(url, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()
            
            if "history" in data and "data" in data["history"]:
                return data["history"]["data"]
            return []
        except requests.RequestException as e:
            print(f"Error fetching market history: {e}", file=sys.stderr)
            return []
    
    def scrape_multiple_symbols(self, symbols: List[str], interval: str = "60", days: int = 7) -> Dict[str, List[Dict]]:
        """
        Scrape candle data for multiple symbols.
        
        Args:
            symbols: List of trading symbols
            interval: Candle interval
            days: Number of days to look back
        
        Returns:
            Dictionary mapping symbols to their candle data
        """
        result = {}
        for symbol in symbols:
            print(f"Scraping {symbol}...", file=sys.stderr)
            result[symbol] = self.get_candles(symbol, interval, days)
        return result


def main():
    """Example usage of the scraper."""
    scraper = MOEXScraper()
    
    print("MOEX ISS Scraper")
    print("=" * 50)
    
    # Get current price for SBER
    print("\n1. Current SBER price:")
    price_data = scraper.get_current_price("SBER")
    if price_data:
        print(f"   Symbol: {price_data['symbol']}")
        print(f"   Last: {price_data['last']}")
        print(f"   Change: {price_data['change']} ({price_data['change_pct']}%)")
        print(f"   Open: {price_data['open']}")
        print(f"   High: {price_data['high']}")
        print(f"   Low: {price_data['low']}")
        print(f"   Volume: {price_data['volume']}")
    else:
        print("   No data available")
    
    # Get recent candles for SBER
    print("\n2. Recent SBER candles (1h interval, last 7 days):")
    candles = scraper.get_candles("SBER", interval="60", days=7)
    if candles:
        print(f"   Found {len(candles)} candles")
        for candle in candles[-3:]:  # Show last 3 candles
            print(f"   {candle['time']}: O={candle['open']}, H={candle['high']}, L={candle['low']}, C={candle['close']}, V={candle['volume']}")
    else:
        print("   No candle data available")
    
    # Get securities list (first 5)
    print("\n3. First 5 securities:")
    securities = scraper.get_securities_list()
    for i, sec in enumerate(securities[:5]):
        secid = sec.get('SECID', 'N/A')
        name = sec.get('SHORTNAME', 'N/A')
        print(f"   {i+1}. {secid}: {name}")
    
    # Get market history
    print("\n4. Market history for today:")
    history = scraper.get_market_history()
    if history:
        print(f"   Found {len(history)} records")
    else:
        print("   No history data available (market may be closed)")
    
    # Batch scrape multiple symbols
    print("\n5. Batch scraping multiple symbols:")
    symbols = ["SBER", "GAZP", "LKOH"]
    batch_data = scraper.scrape_multiple_symbols(symbols, interval="60", days=1)
    for symbol, candles in batch_data.items():
        print(f"   {symbol}: {len(candles)} candles")


if __name__ == "__main__":
    main()
