const NEON = `:root{--pink:#ff3fa4;--cyan:#3ff2ff;--gold:#ffd75e}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#0a0320;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;background:radial-gradient(120% 90% at 50% 0%,#3a0f7a 0%,#12052e 55%,#07021a 100%)}
.logo{font-weight:900;letter-spacing:.02em;background:linear-gradient(90deg,var(--pink),#b388ff,var(--cyan));-webkit-background-clip:text;background-clip:text;color:transparent;text-shadow:0 0 40px rgba(179,136,255,.35)}
.card{padding:6vh 6vw;max-width:1100px;width:100%}
button,input{font:inherit}
.big{font-size:clamp(28px,4.2vw,64px);font-weight:900;padding:.5em 1.4em;border-radius:999px;border:0;color:#14001f;background:linear-gradient(180deg,#ffe27a,#ffb52e);box-shadow:0 0 0 4px rgba(255,255,255,.2),0 0 40px rgba(255,181,46,.6);cursor:pointer}
.big:focus,.big:hover{outline:none;box-shadow:0 0 0 8px #fff,0 0 60px rgba(255,215,94,.9);transform:scale(1.04)}
 .gate-logo{display:block;width:min(86vw,420px);height:auto;margin:0 auto 8px;filter:drop-shadow(0 6px 18px rgba(0,0,0,.45)) drop-shadow(0 0 22px rgba(255,63,164,.35))}
.muted{color:#cbbcff;opacity:.9}`;

export const GATE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>COOLEST! Karaoke Beat Arcade</title>
<style>${NEON}
h1{font-size:clamp(48px,8vw,120px);margin:0 0 .2em}
p{font-size:clamp(22px,2.6vw,40px);margin:.2em 0 1em}
#code{font-size:clamp(40px,6vw,96px);width:6.2em;text-align:center;letter-spacing:.25em;padding:.25em .3em;border-radius:28px;border:4px solid rgba(255,255,255,.35);background:rgba(255,255,255,.08);color:#fff;font-weight:800}
#code:focus{outline:none;border-color:var(--cyan);box-shadow:0 0 0 6px rgba(63,242,255,.35),0 0 50px rgba(63,242,255,.5)}
.row{display:flex;gap:28px;justify-content:center;align-items:center;flex-wrap:wrap}
#msg{min-height:1.5em;font-size:clamp(22px,2.4vw,36px);color:#ffd0e6;margin-top:.8em}
.legal{margin:2.4em auto 0;max-width:34em;font-size:clamp(15px,1.7vw,20px);line-height:1.45;color:#c8c2d8;font-weight:400}
.legal a{color:#e8e4f0;text-decoration:underline}</style></head>
<body><div class="card"><h1 class="logo"><img class="gate-logo" src="/kba/web/m/logo.webp" alt="COOLEST! Karaoke Beat Arcade"></h1><p>🔑 Type the secret code</p>
<form class="row" id="f"><input id="code" inputmode="numeric" autocomplete="off" maxlength="6" autofocus aria-label="Secret code"><button class="big" id="go">OK ▶</button></form>
<div id="msg"></div>
<p class="legal">This is a private, non-commercial Karaoke Beat Arcade party instance for family and friends. It is not for sale and is not monetized. <a href="/kba/about" id="legal">Full disclaimer</a></p>
</div>
<script>
var f=document.getElementById('f'),c=document.getElementById('code'),m=document.getElementById('msg');
c.focus();c.addEventListener('input',function(){c.value=c.value.replace(/\\D/g,'').slice(0,6);if(c.value.length===6)f.requestSubmit?f.requestSubmit():f.onsubmit();});
document.addEventListener('keydown',function(e){var go=document.getElementById('go'),leg=document.getElementById('legal');if(e.keyCode===40){if(document.activeElement===c)go.focus();else if(document.activeElement===go)leg.focus();e.preventDefault();}if(e.keyCode===38){if(document.activeElement===leg)go.focus();else c.focus();e.preventDefault();}});
f.onsubmit=function(e){if(e&&e.preventDefault)e.preventDefault();m.textContent='…';
fetch('/kba/api/invite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c.value}),credentials:'same-origin'}).then(function(r){return r.json()}).then(function(j){if(j.ok)location.replace('/kba/');else{m.textContent='🙈 '+(j.msg||'Try again');c.value='';c.focus();}}).catch(function(){m.textContent='🙈 Ask to try again';});return false;};
</script></body></html>`;

export const MOBILE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#1a0638"><title>COOLEST! Karaoke Beat Arcade</title>
<link rel="preload" as="image" href="/kba/web/m/bg.webp"><style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#12052e;color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
body{min-height:100svh;background:#12052e url(/kba/web/m/bg.webp) center bottom/cover no-repeat fixed}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(70% 45% at 50% 52%,rgba(18,5,46,.62),rgba(18,5,46,0) 75%);pointer-events:none}
.w{position:relative;max-width:460px;margin:0 auto;padding:max(18px,env(safe-area-inset-top)) 20px max(28px,env(safe-area-inset-bottom));display:flex;flex-direction:column;align-items:center;text-align:center}
.logo{width:min(86vw,380px);height:auto;filter:drop-shadow(0 6px 18px rgba(0,0,0,.55)) drop-shadow(0 0 22px rgba(255,63,164,.35))}
.tv{width:min(46vw,190px);height:auto;margin:6px 0 2px;filter:drop-shadow(0 0 26px rgba(63,242,255,.45));animation:f 3.2s ease-in-out infinite}
@keyframes f{50%{transform:translateY(-6px)}}
h1{margin:6px 0 18px;font-size:clamp(30px,9vw,40px);line-height:1.08;font-weight:900;letter-spacing:-.01em;text-shadow:0 2px 0 rgba(0,0,0,.35),0 0 24px rgba(179,136,255,.55)}
.step{display:inline-block;font-size:13px;font-weight:900;letter-spacing:.22em;padding:6px 16px 6px 18px;border-radius:99px;color:#fff;background:linear-gradient(90deg,#ff3fa4,#8b5cff);box-shadow:0 0 14px rgba(255,63,164,.55);margin:6px 0 10px}
.step.two{background:linear-gradient(90deg,#8b5cff,#22c7e8);box-shadow:0 0 14px rgba(63,242,255,.5)}
.url{position:relative;display:inline-block;padding:12px 26px;border-radius:99px;background:rgba(14,4,38,.78);margin-bottom:16px}
.url::before{content:"";position:absolute;inset:0;border-radius:99px;padding:3px;background:linear-gradient(90deg,#ff3fa4,#b388ff,#3ff2ff);-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;filter:drop-shadow(0 0 8px rgba(255,63,164,.8))}
.url{box-shadow:0 0 22px rgba(255,63,164,.45),0 0 34px rgba(63,242,255,.3)}
.url span{font-size:clamp(28px,9vw,38px);font-weight:900;white-space:nowrap;background:linear-gradient(90deg,#ff5fb8,#c08bff 50%,#4ff4ff);-webkit-background-clip:text;background-clip:text;color:transparent}
p{margin:0 0 20px;font-size:19px;line-height:1.38;font-weight:700;max-width:19em;text-shadow:0 1px 8px rgba(0,0,0,.7)}
.copy{display:inline-flex;align-items:center;gap:12px;font-size:28px;font-weight:900;padding:16px 38px;border-radius:99px;border:0;cursor:pointer;color:#3a1600;
background:linear-gradient(180deg,#fff3b0 0%,#ffd84d 38%,#ffb21e 62%,#f08a00 100%);box-shadow:inset 0 2px 0 rgba(255,255,255,.85),inset 0 -4px 0 rgba(150,60,0,.35),0 0 0 3px rgba(255,236,170,.6),0 8px 26px rgba(255,150,20,.55),0 0 40px rgba(255,190,60,.45)}
.copy:active{transform:translateY(2px) scale(.98)}
.copy svg{width:28px;height:28px}
#ok{min-height:1.6em;font-size:20px;color:#ffe27a;margin-top:12px;font-weight:900;text-shadow:0 0 12px rgba(255,200,60,.7)}
.msg{font-size:16px;color:#ffd0e6;margin:-6px 0 12px}
#sel{position:absolute;left:-9999px}
.legal{margin:22px 16px 0;font-size:13px;line-height:1.4;font-weight:400;color:#ddd6ea;text-shadow:0 1px 6px rgba(0,0,0,.7);max-width:22em}
.legal a{color:#fff;text-decoration:underline}</style></head>
<body><main class="w">
<img class="logo" src="/kba/web/m/logo.webp" width="640" height="284" alt="COOLEST! Karaoke Beat Arcade">
<img class="tv" src="/kba/web/m/tv.webp" width="360" height="318" alt="">
<h1>Open this on a TV or computer</h1>
<div class="msg">%%MSG%%</div>
<span class="step">STEP 1</span>
<div class="url"><span id="u"></span></div>
<span class="step two">STEP 2</span>
<p>Then scan the code on the big screen with this phone to sing.</p>
<button class="copy" id="copy"><svg viewBox="0 0 24 24" fill="none" stroke="#3a1600" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2.5" fill="#fff6d8"/><path d="M9 4.5V3.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 10h6M9 14h6M9 18h4"/></svg>Copy link</button>
<div id="ok" role="status"></div><textarea id="sel" readonly></textarea>
<p class="legal">A private, non-commercial karaoke party for family and friends — not for sale and not monetized. <a href="/kba/about">Disclaimer</a></p>
</main>
<script>
var L=location.origin+'/kba',ok=document.getElementById('ok');document.getElementById('u').textContent=L.replace(/^https?:\/\//,'');document.getElementById('sel').value=L;
function done(){ok.textContent='\u2705 Copied!';setTimeout(function(){ok.textContent='';},2500);}
function fallback(){var t=document.getElementById('sel');t.style.left='0';t.focus();t.select();try{t.setSelectionRange(0,999);}catch(e){}var y=false;try{y=document.execCommand('copy');}catch(e){}t.style.left='-9999px';if(y)done();else ok.textContent='Press and hold: '+L;}
document.getElementById('copy').onclick=function(){if(navigator.clipboard&&window.isSecureContext)navigator.clipboard.writeText(L).then(done,fallback);else fallback();};
</script></body></html>`;

export const ABOUT_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Disclaimer \u00b7 COOLEST! Karaoke Beat Arcade</title>
<style>
html,body{margin:0;background:#111;color:#eee;font:18px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:38em;margin:0 auto;padding:28px 20px 64px}
h1{font-size:1.5rem;font-weight:700;margin:0 0 1.2em}
p{margin:0 0 1em}
a{color:#cde}a:focus{outline:2px solid #fff}
.back{display:inline-block;margin-bottom:1.6em;color:#bbb}
</style></head>
<body><main>
<a class="back" href="/kba/">\u2190 Back</a>
<h1>Disclaimer</h1>
<p>This is a private, self-hosted Karaoke Beat Arcade party instance for friends and family. It is not for sale and is not monetized in any way: no ads, fees or subscriptions.</p>
<p>Any songs, lyrics and recordings the host adds belong to their respective artists, labels and publishers. The open-source software ships with no songs; hosts are responsible for using only music they have the rights to.</p>
<p>Rights holders can request removal of any content by contacting the person who runs this instance.</p>
</main></body></html>`;
