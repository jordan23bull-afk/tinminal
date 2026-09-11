import re

be = open("backend/core/times.py", encoding="utf-8").read()
fe = open("frontend/js/constants.js", encoding="utf-8").read()
b = set(re.findall(r'"(\w+)": (\d+)', be))
f = set(re.findall(r'"(\w+)": (\d+)', fe))
assert b == f, b ^ f
print("TF_SECONDS backend==frontend OK")