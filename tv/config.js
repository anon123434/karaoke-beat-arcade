// When served by the local server (browser preview) use that origin. Inside the TV widget, tools/package.py replaces
// __KARAOKE_SERVER__ with host:port of the machine running server/index.js (set KARAOKE_SERVER, e.g. 192.168.1.50:8780).
window.KARAOKE_CONFIG = {
  server: /^https?:/.test(location.protocol) ? location.origin.replace('https:', 'http:').replace(':8743', ':8780') : 'http://__KARAOKE_SERVER__',
  // Delay between the audio clock and what the singer hears from the TV speakers (TV audio pipeline).
  // The per-note ±150 ms timing search absorbs residual error. Tune if scores feel consistently late/early.
  outputLatencyMs: 120
};
try { var saved = +localStorage.getItem('karaoke.outputLatencyMs'); if (saved >= 0 && localStorage.getItem('karaoke.outputLatencyMs') !== null) window.KARAOKE_CONFIG.outputLatencyMs = saved; } catch (e) {}
