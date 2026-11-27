#!/usr/bin/env python3
"""Speech-to-text worker for phone voice search (server/stt.js keeps one alive). stdin: one audio file path per line;
stdout: one JSON line {text, ms} per request. faster-whisper small.en, int8 on CPU; nothing leaves this Mac."""
import sys, json, time, os
from faster_whisper import WhisperModel
m = WhisperModel(os.environ.get('STT_MODEL', 'small.en'), device='cpu', compute_type='int8')
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    p = line.strip()
    if not p: continue
    t = time.time()
    try:
        segs, _ = m.transcribe(p, language='en', beam_size=1, vad_filter=False, condition_on_previous_text=False, initial_prompt='A song title or an artist name for a karaoke library.')
        print(json.dumps({'text': ' '.join(s.text.strip() for s in segs).strip(), 'ms': int((time.time() - t) * 1000)}), flush=True)
    except Exception as e:
        print(json.dumps({'error': str(e)[:200]}), flush=True)
