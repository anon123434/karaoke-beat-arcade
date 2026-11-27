// Online 1v1 stand-in opponents ("ghosts"): when nobody else is online, Quick Match / a challenge falls back to a simulated
// singer after 8-15 s. Runs entirely inside the Match DO, driven by the human screen's own 500 ms score messages
// (no extra relay traffic, no tick alarms). Ghost results never reach the leaderboards or online records (see board.js).
import { avatarOf, nkey } from './online-config.js';

// Plausible display names people type on their phones. Generic first names / nicknames only (no celebrities, no real users).
const NAMES = ['Mia', 'Jordan', 'Tasha', 'Marco', 'Kels', 'Dee', 'Brianna', 'Luis', 'Jenn', 'Andre', 'Sofia', 'Ty', 'Nina', 'Ray', 'Carmen',
  'Josh', 'Kayla', 'Big Mike', 'Lexi', 'Danny', 'Vanessa', 'Chris P', 'Mo', 'Gabby', 'Erik', 'Tina', 'Jamal', 'Priya', 'Hector', 'Liz',
  'Kenny', 'Aaliyah', 'Megan', 'Omar', 'Rosa', 'Trevor', 'Bree', 'Steph', 'Manny', 'Jules', 'Keisha', 'Rob', 'Ana', 'Derek', 'Tori',
  'Sam', 'Ivy', 'Leo', 'Dani', 'Mark T', 'Kim', 'Joey', 'Isa', 'Rico', 'Jade', 'Ben', 'Cece', 'Auntie Lou', 'Paolo', 'Rachel',
  'Tony', 'Lani', 'Desi', 'Gina', 'Kev', 'Maya', 'Alex', 'Vic', 'Noemi', 'Shay'];
export const U = (a, b) => a + Math.random() * (b - a);
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function ghostsOn(env) { return String(env.GHOSTS_ENABLED == null ? '1' : env.GHOSTS_ENABLED) === '1'; }
export function ghostDelay() { return Math.round(U(8000, 15000)); }

// A new opponent: name + face from the pool, base skill, a fake online record (shown on the results card only).
export function makeGhost(avoid = []) {
  const bad = new Set(avoid.map(nkey));
  let name = 'Sam';
  for (let i = 0; i < 20; i++) {
    let n = NAMES[Math.floor(Math.random() * NAMES.length)];
    const r = Math.random();
    if (r < 0.14) n = n.toLowerCase(); else if (r < 0.2) n = n + ' ' + 'ABCDGJKLMPRST'[Math.floor(Math.random() * 13)]; else if (r < 0.24) n = n + Math.floor(U(2, 99));
    if (!bad.has(nkey(n))) { name = n; break; }
  }
  const skill = clamp(66 + 11 * gauss(), 38, 92), games = Math.floor(U(2, 45)), wr = clamp(0.5 + (skill - 66) / 60 + 0.08 * gauss(), 0.15, 0.85);
  const w = Math.round(games * wr);
  return { name, av: avatarOf(name), skill: +skill.toFixed(1), rec: { w, l: games - w, d: Math.random() < 0.3 ? 1 : 0 }, h2h: { g: 0, h: 0, d: 0 } };
}

// One round: per-line accuracy plan (pitch error with drift, missed lines, late entries, streaks) + what the ghost does
// around the song (connect delay, lag bursts, a dropped connection, rarely leaving early).
export function planRound(g, prof, d, prevHumanWon) {
  const L = prof ? prof.L : [[2, Math.max(4, d - 2), 1000, 40]];
  const mult = 1.06 - 0.2 * (prof ? prof.df : 0.5);
  const base = clamp((g.skill * mult + 4 * gauss()) / 100, 0.2, 0.95);
  const acc = []; let drift = 0, streak = 0;
  for (let i = 0; i < L.length; i++) {
    drift = 0.75 * drift + 0.06 * gauss();                     // pitch error wanders from line to line
    if (!streak && Math.random() < 0.1) streak = 2 + Math.floor(Math.random() * 3);
    let a = base + drift + (streak ? 0.08 : 0); if (streak) streak--;
    if (i < 2 && Math.random() < 0.25) a *= U(0.5, 0.8);       // warming up
    if (Math.random() < 0.025 + (1 - g.skill / 100) * 0.07) a = U(0, 0.08);   // missed line
    else if (Math.random() < 0.08) a *= U(0.45, 0.75);         // late entry
    acc.push(+clamp(a, 0, 0.98).toFixed(3));
  }
  // target ~50 % human wins: a bit kinder after the human lost the last round, a bit tougher after a win
  const pGhost = prevHumanWon == null ? 0.56 : prevHumanWon ? 0.6 : 0.48;
  const r = Math.random(), ev = [];
  if (r < 0.03) { const at = U(0.3, 0.8); ev.push({ f: at, k: 'gone' }, { f: at, k: 'quit', dt: 15500 }); }
  else if (r < 0.1) { const at = U(0.15, 0.85); ev.push({ f: at, k: 'gone' }, { f: at, k: 'back', dt: Math.round(U(2500, 8500)) }); }
  return { acc, base0: acc.slice(), wantWin: Math.random() < pGhost, margin: +U(1.5, 8).toFixed(1), ev, next: 0, live: 0, combo: 0, best: 0 };
}

const lineFrac = (l, t) => clamp((t - l[0] - 0.3) / Math.max(0.2, l[1] - l[0]), 0, 1);
// Score (0-100, banked so far, like LiveScorer.liveScore) and combo at song time t (s)
export function ghostLive(R, prof, t) {
  const L = prof ? prof.L : [[2, 200, 1000, 40]];
  let earned = 0, combo = 0, best = 0;
  for (let i = 0; i < L.length; i++) {
    const f = lineFrac(L[i], t); if (!f) break;
    earned += R.acc[i] * L[i][2] / 1000 * f;
    const notes = Math.floor(L[i][3] * f), a = R.acc[i];
    if (a >= 0.72) combo += notes; else if (a < 0.2) combo = 0; else combo = Math.floor(notes * (a - 0.2));
    best = Math.max(best, combo);
  }
  return { score: Math.round(100 * earned), combo, best };
}
export function elapsedWeight(prof, t) { if (!prof) return 0; let w = 0; for (const l of prof.L) w += l[2] / 1000 * lineFrac(l, t); return w; }

// Light rubber band: nudge only the lines still to come, a little per tick, toward "close to the human, on the planned side".
export function rubberBand(R, prof, t, humanLive) {
  if (!prof) return;
  const W = elapsedWeight(prof, t); if (W < 0.12 || W > 0.95) return;
  const hp = clamp(humanLive / W, 0, 100);
  let natural = 0, fut = 0, earned = 0;
  prof.L.forEach((l, i) => { const f = lineFrac(l, t), w = l[2] / 1000; natural += R.base0[i] * w * 100; earned += R.acc[i] * w * f * 100; fut += R.acc[i] * w * (1 - f) * 100; });
  if (hp < 12 && natural > 40) return;                         // the human isn't really singing: no reason to tank
  const target = hp + (R.wantWin ? R.margin : -R.margin);
  const desired = clamp(natural + 0.75 * (target - natural), Math.max(25, natural - 15), natural + 15);   // light: at most 15 points either way, never a tank job
  if (fut < 1) return;
  const want = clamp((desired - earned) / fut, 0.6, 1.45), step = 1 + 0.3 * (want - 1);
  prof.L.forEach((l, i) => { const f = lineFrac(l, t); if (f < 1) R.acc[i] = +clamp(R.acc[i] * step, 0, 0.98).toFixed(3); });
}

// Final score: what the ghost banked; if it lands within a few points on the wrong side of the plan, tip it (draws are rare).
export function ghostFinal(R, prof, humanFinal) {
  let s = ghostLive(R, prof, 1e6).score;
  if (humanFinal != null && humanFinal >= 15) {
    const diff = s - humanFinal;
    if (Math.abs(diff) <= 4 && (diff > 0) !== R.wantWin) s = humanFinal + (R.wantWin ? 1 + Math.floor(Math.random() * 3) : -(1 + Math.floor(Math.random() * 3)));
    else if (diff === 0 && Math.random() > 0.05) s += R.wantWin ? 1 : -1;
  }
  return clamp(Math.round(s), 0, 100);
}
