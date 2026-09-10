import sys
import time
sys.path.insert(0, "backend")
from core.app import PocAggregator

OFF = 4 * 3600
WINDOW = 4 * 3600
day_start = 1750000000 // 86400 * 86400 + OFF
candles = [(ts, 100.0, 101.0, 99.0, 500) for ts in range(day_start, day_start + 8 * 3600, 60)]

def run(buffered):
    agg = PocAggregator(0.01, WINDOW, OFF)
    # детерминированная гонка: live-сделка "сейчас" (09:00, в бакете 08:00-12:00)
    # приходит, пока префилл прокормил только ПЕРВУЮ свечу дня (04:00).
    # в app.py это feed из тред-колбэка, вклинивающийся между feed_candle вызовами
    agg.feed_candle(*candles[0])          # 04:00 — префилл начал
    if buffered:
        # буфер app.py: сделка не кормится до конца префилла
        pending = [(day_start + 9 * 3600, 100.5, 1000)]
    else:
        agg.feed(day_start + 9 * 3600, 100.5, 1000)   # БАГ: кормим сразу
        pending = []
    for ts, o, h, l, v in candles[1:]:    # префилл продолжает 04:01..12:00
        agg.feed_candle(ts, o, h, l, v)
    for ts, p, q in pending:              # app.py: дренаж после префилла
        agg.feed(ts, p, q)
    return agg.snapshot(int(time.time()))["finals"]

broken = run(buffered=False)
starts_broken = [f["start"] for f in broken]
print("interleaved:", [time.strftime('%H:%M', time.gmtime(s)) for s in starts_broken], "values:", [f["value"] for f in broken])
assert starts_broken != sorted(starts_broken), "ожидалось, что без буфера порядок finals сломан"

fixed = run(buffered=True)
starts = [f["start"] for f in fixed]
print("buffered:   ", [time.strftime('%H:%M', time.gmtime(s)) for s in starts], "values:", [f["value"] for f in fixed])
assert starts == sorted(starts), f"finals not in order: {starts}"
for s in starts:
    assert (s - OFF) % WINDOW == 0, f"bucket {s} not aligned"
assert starts and starts[0] == day_start, "первый final должен быть начало сессии"
print("prefill race fix OK — finals в порядке, выровнены по сессии")