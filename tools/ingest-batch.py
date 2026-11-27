#!/usr/bin/env python3
"""
Batch song ingest (one command, scales to many songs; personal home use with songs you own).

  npm run ingest -- <file.mp3> 'Artist - Title' [<file2.mp3> 'Artist - Title' ...] [--force] [--no-install]
  npm run ingest:incoming            # every line of ~/karaoke-songs-incoming/songs.txt  ("file.mp3 | Artist - Title")

Per song: tools/ingest.py (Demucs -> whisper -> LRCLIB by title/artist + duration -> pYIN melody -> songs/user-*/),
then disk cleanup: the Demucs WAVs are deleted and only FLAC stems are kept in .local/ingest/stems/<name>/.
Songs already ingested from the same source file are skipped unless --force. At the end the TV song index is
rebuilt and (unless --no-install) the app is re-packaged, installed and launched on the TV.
"""
import os, re, shutil, subprocess, sys, json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.local/ingest'
PY = ROOT / '.venv-ingest/bin/python'
INCOMING = Path.home() / 'karaoke-songs-incoming'
MIN_FREE_GB = 4


def log(*a):
    print('[batch]', *a, flush=True)


def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower().replace("'", '')).strip('-')[:40]


def free_gb():
    return shutil.disk_usage(str(ROOT)).free / 1e9


def parse_spec(spec):
    if ' - ' not in spec:
        sys.exit('song name must look like "Artist - Title": %r' % spec)
    artist, title = spec.split(' - ', 1)
    return artist.strip(), title.strip()


def compact(stem):
    """Keep only FLAC stems; delete Demucs WAV output."""
    d = WORK / 'demucs/htdemucs' / stem
    keep = WORK / 'stems' / stem
    keep.mkdir(parents=True, exist_ok=True)
    for src, dst in (('vocals.wav', 'vocals.flac'), ('no_vocals.wav', 'instrumental.flac')):
        if (d / src).exists() and not (keep / dst).exists():
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(d / src), str(keep / dst)], check=True)
    if (keep / 'vocals.flac').exists() and (keep / 'instrumental.flac').exists():
        shutil.rmtree(d, ignore_errors=True)


def main(argv):
    force = '--force' in argv
    install = '--no-install' not in argv
    args = [a for a in argv if not a.startswith('--')]
    jobs = []
    if argv[:1] == ['--incoming'] or (not args and (INCOMING / 'songs.txt').exists()):
        for line in (INCOMING / 'songs.txt').read_text().splitlines():
            if '|' in line and not line.strip().startswith('#'):
                f, spec = line.split('|', 1)
                jobs.append((INCOMING / f.strip(), spec.strip()))
    else:
        if len(args) % 2:
            sys.exit(__doc__)
        jobs = [(Path(args[i]).expanduser(), args[i + 1]) for i in range(0, len(args), 2)]
    ok, failed, skipped = [], [], []
    for path, spec in jobs:
        artist, title = parse_spec(spec)
        sid = 'user-' + slug(title)
        if not path.exists():
            failed.append((spec, 'file not found: %s' % path)); continue
        sj = ROOT / 'songs' / sid / 'song.json'
        if sj.exists() and not force:
            meta = json.loads(sj.read_text())
            if meta.get('ingest', {}).get('source') == path.name:
                compact(path.stem); skipped.append(spec); log('skip (already ingested):', spec); continue
        if free_gb() < MIN_FREE_GB:
            failed.append((spec, 'low disk: %.1f GB free' % free_gb())); log('STOP: low disk'); break
        log('=== %s  (%s, %.1f GB free)' % (spec, path.name, free_gb()))
        logf = WORK / (path.stem + '.ingest.log')
        WORK.mkdir(parents=True, exist_ok=True)
        with open(logf, 'w') as lf:
            r = subprocess.run([str(PY), str(ROOT / 'tools/ingest.py'), str(path), '--id', sid, '--title', title, '--artist', artist],
                               stdout=lf, stderr=subprocess.STDOUT)
        compact(path.stem)
        if r.returncode == 0 and sj.exists():
            rep = json.loads(sj.read_text())['ingest']; m = rep['melody']
            ok.append(spec); globals().setdefault('OK_IDS', []).append(sid)
            log('ok: %s | lyrics: %s | %s notes (%ss sung) | range %s' % (sid, rep['lyrics_source'], m['notes'], m.get('note_seconds'), m['range']))
        else:
            failed.append((spec, 'see ' + str(logf))); log('FAILED:', spec, '-> see', logf)
    subprocess.run([str(PY), str(ROOT / 'tools/beats.py'), '--all'], check=False)   # Beat mode maps (skips songs that have one)
    subprocess.run([str(PY), str(ROOT / 'tools/chart.py')], check=False)   # instrument charts from 4-stem Demucs (skips charted songs)
    ok_ids = [slug_id for slug_id in (globals().get('OK_IDS') or [])]
    if ok_ids: subprocess.run([str(PY), str(ROOT / 'tools/align-words.py')] + ok_ids, check=False)   # word re-timing: CTC forced alignment on the vocal stem
    subprocess.run(['node', str(ROOT / 'tools/build-index.js')], check=True)
    if install and ok:
        log('packaging + installing on the TV')
        subprocess.run(['/usr/bin/python3', str(ROOT / 'tools/package.py')], check=True)
        subprocess.run(['/usr/bin/python3', str(ROOT / 'tools/tv.py'), 'install'], check=True)
        subprocess.run(['/usr/bin/python3', str(ROOT / 'tools/tv.py'), 'launch'], check=True)
    log('summary: %d ok, %d skipped, %d failed; %.1f GB free' % (len(ok), len(skipped), len(failed), free_gb()))
    for s, why in failed:
        log('  failed:', s, '-', why)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
