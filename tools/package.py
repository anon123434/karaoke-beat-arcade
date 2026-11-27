"""Assemble the TV widget and sign it with your own Tizen signing profile (no profile/cert changes).

Needs .local/signing.json: {"sdk_path": "...tizen-studio", "profile": "<your profile name>", "app_id": "KaraokeBA1.KaraokeTV", "package_id": "KaraokeBA1"}
and KARAOKE_SERVER=<host:port of the machine running server/index.js> (or "server" in .local/device.json).
"""
import json, os, re, shutil, subprocess, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
cfg = json.loads((ROOT / '.local/signing.json').read_text())
cli = Path(cfg['sdk_path']) / 'tools/ide/bin/tizen'
dist = ROOT / 'dist'
app = dist / 'app'
shutil.rmtree(dist, ignore_errors=True)
(app / 'shared').mkdir(parents=True)
(app / 'songs/calibration').mkdir(parents=True)
for f in ['beeps.wav', 'calibration.json']:
    shutil.copy(ROOT / 'songs/calibration' / f, app / 'songs/calibration' / f)
for f in ['index.html', 'style.css', 'app.js', 'queue.js', 'engine.js', 'lane.js', 'beat.js', 'config.js', 'config.xml', 'icon.png']:
    shutil.copy(ROOT / 'tv' / f, app / f)
(app / 'img').mkdir()
for f in (ROOT / 'tv/img').iterdir():
    if f.suffix in ('.jpg', '.webp', '.png'):
        shutil.copy(f, app / 'img' / f.name)
for f in ['scoring.js', 'song-source.js', 'search.js']:
    shutil.copy(ROOT / 'shared' / f, app / 'shared' / f)
shutil.copy(ROOT / 'songs/index.json', app / 'songs/index.json')
for entry in json.loads((ROOT / 'songs/index.json').read_text()):
    (app / 'songs' / entry['id']).mkdir(parents=True)
    meta = json.loads((ROOT / 'songs' / entry['id'] / 'song.json').read_text())
    for f in ['song.json']:   # audio streams from the local server (:8780); bundling it made a 157 MB wgt the TV rejected (download failed[116])
        shutil.copy(ROOT / 'songs' / entry['id'] / f, app / 'songs' / entry['id'] / f)
server = os.environ.get('KARAOKE_SERVER', '')
dev = ROOT / '.local/device.json'
if not server and dev.exists():
    server = json.loads(dev.read_text()).get('server', '')
if not re.fullmatch(r'[A-Za-z0-9.-]+:\d{2,5}', server or ''):
    sys.exit('Set KARAOKE_SERVER=<host:port> of the machine running server/index.js (e.g. 192.168.1.50:8780).')
cfgjs = (app / 'config.js').read_text()
assert '__KARAOKE_SERVER__' in cfgjs
(app / 'config.js').write_text(cfgjs.replace('__KARAOKE_SERVER__', server))
xml = (app / 'config.xml').read_text()
assert 'id="%s"' % cfg['app_id'] in xml and 'package="%s"' % cfg['package_id'] in xml, 'config.xml identity mismatch'
out = dist / 'signed'
# SDK output can echo profile details; keep it out of logs and only report success/failure.
r = subprocess.run([str(cli), 'package', '-t', 'wgt', '-s', cfg['profile'], '-o', str(out), '--', str(app)],
                   stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180)
wgts = list(out.glob('*.wgt')) if out.exists() else []
if r.returncode or not wgts:
    sys.exit('Signing failed (exit %s). Check your signing profile in Certificate Manager.%s' % (
        r.returncode, ' SDK asked for a password.' if 'password' in (r.stdout + r.stderr).lower() else ''))
target = dist / 'KaraokeTV.wgt'
wgts[0].replace(target)
with zipfile.ZipFile(target) as z:
    names = z.namelist()
    assert 'author-signature.xml' in names and 'signature1.xml' in names, 'widget not signed'
    assert re.search(r'id="%s"' % re.escape(cfg['app_id']), z.read('config.xml').decode())
print('Signed widget: %s (%.1f MB, %d files)' % (target, target.stat().st_size / 1e6, len(names)))
