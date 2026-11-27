// Hosted web build: everything is served by the Cloudflare Worker under /kba.
window.KARAOKE_CONFIG = { server: location.origin + '/kba', outputLatencyMs: 120, web: true };
try { var saved = +localStorage.getItem('karaoke.outputLatencyMs'); if (saved >= 0 && localStorage.getItem('karaoke.outputLatencyMs') !== null) window.KARAOKE_CONFIG.outputLatencyMs = saved; } catch (e) {}
(function () {
  var r = ''; try { r = localStorage.getItem('ktv.room') || ''; } catch (e) {}
  if (!/^[a-z2-9]{6}$/.test(r)) {
    var A = 'abcdefghjkmnpqrstuvwxyz23456789', b = new Uint8Array(6); crypto.getRandomValues(b);
    r = ''; for (var i = 0; i < 6; i++) r += A[b[i] % A.length];
    try { localStorage.setItem('ktv.room', r); } catch (e) {}
  }
  window.KTV_ROOM = r;
  try { if (localStorage.getItem('karaoke.guideLevel') == null) localStorage.setItem('karaoke.guideLevel', 'full'); } catch (e) {}
})();
