/* eslint-disable no-console */
import axios from 'axios';
import { load } from 'cheerio';

/* ─── manifest ─────────────────────────────────────────── */
const MANIFEST = {
  id: 'org.ruslan.puzzlemovies',
  version: '1.4.0',
  name: 'Puzzle-Movies',
  description: 'Streams from puzzle-movies.com (cookie auth)',
  logo: 'https://puzzle-movies.com/favicons/movies/apple-touch-icon.png',
  types: ['movie'],
  resources: ['catalog', 'meta', 'stream'],
  idPrefixes: ['tt', 'tmdb', 'puzzle:'],
  catalogs: [{
    type: 'movie',
    id: 'puzzle-search',
    name: 'Puzzle Search',
    extra: [{ name: 'search', isRequired: true }]
  }]
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

/* ─── small helpers ────────────────────────────────────── */
const log = (...a) => console.log('[DBG]', ...a);
const fromB64 = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

const canon   = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const slugify = s => s.toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/--+/g, '-');

const axiosCookie = c => axios.create({
  baseURL: 'https://puzzle-movies.com',
  headers: { Cookie: c, 'User-Agent': 'Mozilla/5.0' },
  timeout: 8000
});

/* ─── cinematA (title/year from IMDb) ───────────────────── */
async function getCinemeta(id) {
  const path = id.startsWith('tt') ? id : id.replace('tmdb:', 'tmdb/');
  try {
    const { data } = await axios.get(
      `https://v3-cinemeta.strem.io/meta/movie/${path}.json`,
      { timeout: 8000 }
    );
    return data.meta || null;
  } catch {
    return null;
  }
}

/* ─── scrape helpers ───────────────────────────────────── */
async function searchPage(http, title, year) {
  const url = `/search-result?search_term=${encodeURIComponent(`${title} ${year || ''}`)}`;
  const html = (await http.get(url)).data;
  const $ = load(html);
  const hits = [];

  $('.puzzle-movies__content-items .puzzle-movies__selected-item').each((_, el) => {
    const $el   = $(el);
    const slug  = ($el.find('a').attr('href') || '').split('/').pop();
    if (!slug) return;

    const slugYear = Number(/-(\d{4})$/.exec(slug)?.[1]) || 0;
    const movieTitle = $el.find('.puzzle-movies__selected-title').text().trim();
    const movieYear  = slugYear ||
      Number($el.find('.puzzle-movies__selected-popup-content-bot-year').text()) || 0;

    if (year && movieYear !== year) return;         // strict year filter if asked
    hits.push({ slug, title: movieTitle, year: movieYear });
  });
  return hits;
}

async function getHls(http, slug) {
  const html = (await http.get(`/films/${slug}`)).data;
  return html.match(/hlsUrl:\s*["']([^"']+\.m3u8)["']/)?.[1] || null;
}

/* ─── brute probe ───────────────────────────────────────── */
async function brute(http, title, year) {
  const slugGuess = `${slugify(title)}-${year}`;
  try {
    const hls = await getHls(http, slugGuess);
    if (hls) return { slug: slugGuess, title, year, hls };
  } catch {}
  return null;
}

/* ─── tiny HTML for cookie configurator ────────────────── */
const CONFIG = `<!DOCTYPE html><meta charset=utf-8>
<title>Puzzle-Movies → Stremio</title>
<style>body{font-family:sans-serif;max-width:460px;margin:2rem auto}</style>
<h2>Puzzle-Movies → Stremio</h2>
<p>Paste your <code>Cookie</code> header from puzzle-movies.com</p>
<form id=f><textarea name=cookies rows=4 style="width:100%" required></textarea>
<br><br><button>Generate link</button></form>
<p id=o style="word-break:break-all;margin-top:1.5rem"></p>
<script>
f.onsubmit=e=>{
 e.preventDefault();
 const tok=btoa(unescape(encodeURIComponent(JSON.stringify({cookies:f.cookies.value.trim()}))))
   .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
 o.textContent=location.origin+'/'+tok+'/manifest.json';
};
</script>`;

/* ─── main serverless handler ──────────────────────────── */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS')
    return res.writeHead(204, CORS).end();

  const { pathname, searchParams } = new URL(req.url, 'http://x');
  if (pathname === '/')
    return send(res, 200, CONFIG, 'text/html');

  /* token extraction */
  const segs = pathname.split('/').filter(Boolean);
  let cfg;
  if (segs.length && !['manifest.json','catalog','meta','stream'].includes(segs[0])) {
    try { cfg = fromB64(segs.shift()); } catch {}
  }
  if (!cfg?.cookies)
    return send(res, 400, { err: 'missing cookies' });

  const http = axiosCookie(cfg.cookies);

  /* manifest */
  if (/^manifest(\.json)?$/.test(segs[0] || ''))
    return send(res, 200, MANIFEST);

  /* catalog */
  if (segs[0] === 'catalog') {
    const term = (searchParams.get('search') || '').trim();
    if (!term) return send(res, 200, { metas: [] });

    /* slug short-circuit */
    if (/^[a-z0-9-]+-\d{4}$/.test(term))
      return send(res, 200, { metas: [{
        id: `puzzle:${term}`, type: 'movie',
        name: term.replace(/-/g, ' ')
      }] });

    /* pick year: 4-digit or trailing 2-digit */
    let year;
    const m4 = term.match(/(19|20)\d{2}(?!.*\d)/);
    const m2 = term.match(/\b(\d\d)(?!.*\d)/);
    if (m4) year = +m4[0];
    else if (m2) year = (+m2[1] < 30 ? 2000 : 1900) + +m2[1];

    const title = year ? term.replace(/(19|20)?\d{2}$/, '').trim() : term;

    let hits = await searchPage(http, title, year);
    /* brute fallback if nothing came back */
    if (!hits.length && year) {
      const bruteHit = await brute(http, title, year);
      if (bruteHit) hits = [bruteHit];
    }

    const metas = hits.map(h => ({
      id: `puzzle:${h.slug}`,
      type: 'movie',
      name: `${h.title}${h.year ? ` (${h.year})` : ''}`
    }));
    return send(res, 200, { metas });
  }

  /* meta */
  if (segs[0] === 'meta') {
    const id = segs[2]?.replace(/\.json$/i, '');
    if (!id) return send(res, 404, {});

    if (id.startsWith('puzzle:')) {
      const slug = id.slice(7);
      const hls  = await getHls(http, slug);
      return send(res, 200, { meta: { id, type: 'movie', name: slug, hls } });
    }

    const cm = await getCinemeta(id);
    if (!cm) return send(res, 200, { meta: {} });

    let slug, hls;
    let hits = await searchPage(http, cm.name, cm.year);
    if (hits.length) {
      slug = hits[0].slug;
      hls  = await getHls(http, slug);
    }
    if (!hls) {
      const bruteHit = await brute(http, cm.name, cm.year);
      slug = bruteHit?.slug;
      hls  = bruteHit?.hls;
    }
    return send(res, 200, { meta: { id, type: 'movie', name: cm.name, hls } });
  }

  /* stream */
  if (segs[0] === 'stream') {
    const id = segs[2]?.replace(/\.json$/i, '');
    let hls;

    if (id.startsWith('puzzle:')) {
      hls = await getHls(http, id.slice(7));
    } else {
      const cm = await getCinemeta(id);
      if (cm) {
        const hits = await searchPage(http, cm.name, cm.year);
        if (hits.length) hls = await getHls(http, hits[0].slug);
        if (!hls) {
          const bruteHit = await brute(http, cm.name, cm.year);
          hls = bruteHit?.hls;
        }
      }
    }
    return send(res, 200, { streams: hls ? [{
      url: hls, title: 'Puzzle-Movies (HLS)', isFree: true
    }] : [] });
  }

  send(res, 404, { err: 'not found' });
}

/* ─── utility responder ────────────────────────────────── */
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { ...CORS, 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
