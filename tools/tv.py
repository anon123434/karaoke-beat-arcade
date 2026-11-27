"""Install or launch KaraokeTV on the TV over SDB. TV address: TIZEN_TV_HOST env or .local/device.json {"host": "<tv ip>"}. Never touches Home button/startup/autostart settings."""
import argparse, hashlib, json, os, subprocess, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(); p.add_argument('action', choices=['install', 'launch', 'info']); args = p.parse_args()
cfg = json.loads((ROOT / '.local/signing.json').read_text())
host = os.environ.get('TIZEN_TV_HOST') or json.loads((ROOT / '.local/device.json').read_text())['host']
sdb = str(Path(cfg['sdk_path']) / 'tools/sdb')
serial = host + ':26101'
app_id = cfg['app_id']

def run(*a, quiet=False):
    r = subprocess.run([sdb, *a], text=True, capture_output=True, timeout=60)
    out = r.stdout + r.stderr
    if not quiet: print(out.strip())
    return r.returncode, out

for attempt in range(3):
    _, out = run('connect', serial)
    if 'connected to' in out.lower() or 'already connected' in out.lower():
        break
    run('kill-server', quiet=True); time.sleep(3)
else:
    sys.exit('TV not reachable over SDB (Developer Mode connection down). Unplug the TV ~30 s, plug back in, wait ~25 s after boot, retry.')

if args.action == 'info':
    run('-s', serial, 'capability')
elif args.action == 'launch':
    _, out = run('-s', serial, 'shell', '0', 'execute', app_id)
    if 'successfully launched' not in out: sys.exit('Launch not confirmed.')
else:
    wgt = ROOT / 'dist/KaraokeTV.wgt'
    if not wgt.exists(): sys.exit('Run npm run package first.')
    remote = '/home/owner/share/tmp/sdk_tools/KaraokeTV-%s.wgt' % hashlib.sha256(wgt.read_bytes()).hexdigest()[:12]
    _, out = run('-s', serial, 'push', str(wgt), remote)
    if '1 file(s) pushed' not in out and ' bytes in ' not in out: sys.exit('Widget transfer not confirmed.')
    _, out = run('-s', serial, 'shell', '0', 'vd_appinstall', app_id, remote)
    if 'install completed' not in out or 'install failed' in out: sys.exit('TV install failed.')
    _, out = run('-s', serial, 'shell', '0', 'applist', quiet=True)
    if app_id not in out: sys.exit('App not in installed list.')
    print('KaraokeTV installed (%s). Home/startup settings unchanged.' % app_id)
