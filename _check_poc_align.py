import sys
import time
sys.path.insert(0, "backend")
from core.app import PocAggregator

OFFSET = 4 * 3600  # 04:00 UTC = 07:00 MSK
ts = 1750000000  # любой момент времени
ok = True
for w in (30, 60, 120, 240, 480, 1440):
    b = PocAggregator(0.01, w * 60, OFFSET)._bucket(ts)
    aligned = (b - OFFSET) % (w * 60) == 0
    print(f"{w:>4}m bucket={time.strftime('%H:%M', time.gmtime(b))} aligned={aligned}")
    ok = ok and aligned
# бакет, покрывающий начало сессии, начинается ровно в 04:00 UTC для ВСЕХ окон
for w in (30, 60, 120, 240, 480, 1440):
    b = PocAggregator(0.01, w * 60, OFFSET)._bucket(OFFSET)
    assert b == OFFSET, (w, b)
    print(f"{w:>4}m session-start bucket ok={b == OFFSET}")
exit(0 if ok else 1)