"""Real-TV fps per game session from .local/perf.log (sessions split by gaps > 10 s).
Usage: /usr/bin/python3 tools/fps-report.py [build]   e.g. v12.1"""
import json, sys
from datetime import datetime, timedelta
from statistics import median
build = sys.argv[1] if len(sys.argv) > 1 else None
rows = []
for l in open('.local/perf.log'):
    try: j = json.loads(l)
    except Exception: continue
    if j.get('src') == 'tv' and j.get('screen') == 'game' and (not build or j.get('build') == build) and 'T' in str(j.get('at')): rows.append(j)
sess, cur, prev = [], [], None
for j in rows:
    t = datetime.fromisoformat(j['at'].replace('Z', '+00:00'))
    if prev and (t - prev).total_seconds() > 10: sess.append(cur); cur = []
    cur.append((t, j)); prev = t
if cur: sess.append(cur)
for s in sess:
    f = sorted(x[1]['fps'] for x in s)
    start = (s[0][0] - timedelta(hours=8)).strftime('%H:%M:%S')
    print('%s PT  %-6s %4d s  median %5.1f  p10 %5.1f  min %5.1f' % (start, s[0][1].get('build'), len(s) * 2, median(f), f[len(f) // 10], f[0]))
