// Online 1v1 settings. Flags live in wrangler.toml [vars] (ONLINE_ENABLED, LB_PANEL_ENABLED; "1" = on, default off).
// QUICK_MATCH_SONGS: song ids (see songs/index.json) that Quick Match draws from at random. Ids that are not in your library are ignored.
// Challenges themselves can use any song in your library. Add the ids of the songs you want in the quick-match pool.
export const QUICK_MATCH_SONGS = ['twinkle', 'amazing-grace'];
export const DAILY_MATCH_CAP = 300;          // matches per UTC day; lobby says "Online is resting" when hit
export const CHALLENGE_TTL_MS = 10 * 60e3;   // open challenge expires after 10 min with no opponent
export const BEAT_TIMEOUT_MS = 15e3;         // host heartbeat gone -> challenge removed
export const READY_TIMEOUT_MS = 25e3;        // both screens must load the song in this window
export const RECONNECT_GRACE_MS = 15e3;      // mid-song drop: come back within 15 s or forfeit
export const LIMITS = { create: [6, 3600e3], createIp: [20, 3600e3], join: [30, 3600e3], quick: [30, 3600e3], report: [10, 3600e3], connect: [40, 60e3] };

// SUB: blocked anywhere in the name (also with dots/leet). WORD: blocked only as a whole word, so Essex, Hancock, Dickens, Grape, Spice pass.
const SUB = ['fuck', 'shit', 'bitch', 'cunt', 'nigg', 'pussy', 'whore', 'slut', 'porn', 'penis', 'vagina', 'retard', 'twat', 'wank', 'asshole', 'hitler'];
const WORD = ['sex', 'cock', 'dick', 'fag', 'rape', 'nazi', 'kkk', 'kike', 'spic', 'chink', 'bastard', 'cum', 'tits'];
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };
export function badName(n) {
  const low = String(n || '').toLowerCase().replace(/[0134578@$!]/g, c => LEET[c] || c), s = low.replace(/[^a-z]/g, '');
  const words = low.split(/[^a-z]+/).filter(Boolean);
  return SUB.some(w => s.includes(w)) || words.some(w => WORD.includes(w) || WORD.some(b => w === b + 's')) || WORD.includes(s) || /https?|www|\.com|\.co\b/i.test(String(n || ''));
}
export function cleanOnlineName(n) {
  n = String(n || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  if (!n || badName(n)) return 'Singer ' + (100 + Math.floor(Math.random() * 900));
  return n;
}
export const nkey = n => String(n).toLowerCase().replace(/\s+/g, ' ').trim();
// avatar index 0-7 from the name, so a player looks the same everywhere (lobby, VS, leaderboards)
export function avatarOf(name) { let h = 2166136261; for (const c of nkey(name)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) % 8; }
export const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const rid = (n = 10) => { const A = 'abcdefghjkmnpqrstuvwxyz23456789', b = new Uint8Array(n); crypto.getRandomValues(b); let s = ''; for (const x of b) s += A[x % A.length]; return s; };
