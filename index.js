/* eslint-disable no-console */
/* ─── imports ───────────────────────────────────────────── */
import axios from 'axios';
import { load } from 'cheerio';

/* ─── constants ─────────────────────────────────────────── */
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age':      '86400'
};

const MANIFEST = {
  id:          'org.ruslan.puzzlemovies',
  version:     '2.8.0',
  name:        'Puzzle-Movies',
  description: 'Streams from puzzle-movies.com (cookie auth, verbose)',
  logo:        'https://puzzle-movies.com/favicons/movies/apple-touch-icon.png',
  types:       ['movie'],
  resources:   ['catalog','meta','stream'],
  idPrefixes:  ['tt','tmdb','puzzle:'],
  catalogs: [{
    type:'movie', id:'puzzle-search', name:'Puzzle Search',
    extra:[{ name:'search', isRequired:true }]
  }]
};

/* ─── helpers ───────────────────────────────────────────── */
const log = (...a)=>console.log('[DBG]',...a);

const b64 = s => JSON.parse(Buffer.from(s,'base64url').toString('utf8'));

async function fetchCinemeta(id){
  const path=id.startsWith('tt')?id:id.replace('tmdb:','tmdb/');
  try{
    const { data } = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${path}.json`,{timeout:8000});
    log('cinemeta',path);
    return data.meta||null;
  }catch(e){ log('cinemeta fail',e.message); return null;}
}

const slugify = s => s.toLowerCase()
  .replace(/[^a-z0-9]+/g,'-')
  .replace(/^-+|-+$/g,'')
  .replace(/--+/g,'-');

const mp4ToHls = u => u.endsWith('.mp4')? u.replace(/\.mp4$/,'.mp4/master.m3u8') : null;

const makeHttp = cookie => axios.create({
  baseURL:'https://puzzle-movies.com',
  headers:{ Cookie:cookie, 'User-Agent':'Mozilla/5.0' },
  timeout:8000
});

/* ─── site scrape helpers ───────────────────────────────── */
async function search(http, title, year) {
  const q = encodeURIComponent(`${title} ${year}`);
  const { data } = await http.get(`/search-result?search_term=${q}`);
  log('GET /search-result', q, 'html', data.length);

  const $ = load(data);
  const hits = [];
  $('.movie-card').each((i, el) => {
    const movieTitle = $(el).find('.movie-card-title').text().trim();
    const movieYear = Number(
      $(el).find('.movie-card-subtitle').text().match(/\d{4}/)
    );
    const slug = $(el).find('a').attr('href')?.split('/').pop();
    if (slug && movieYear && movieTitle) {
      hits.push({ slug, year: movieYear, title: movieTitle });
    }
  });

  log('search hits', hits.length, hits.map(h=>`${h.title} (${h.year})`).slice(0,5).join('; '));

  // Find the *best* match: exact year and (case/space-insensitive) title
  const clean = x => x.toLowerCase().replace(/\s+/g,'').replace(/[^a-z0-9]/g,'');
  const targetTitle = clean(title);

  const found = hits.find(
    h =>
      h.year === year &&
      clean(h.title) === targetTitle
  );
  // If not found by exact match, fallback to matching year
  return found || hits.find(h => h.year === year) || null;
}

async function details(http, slug) {
  const { data } = await http.get(`/films/${slug}`);
  log('GET /films', slug, 'html', data.length);

  const hlsMatch = data.match(/hlsUrl:\s*["']([^"']+\.m3u8)["']/);
  const hls = hlsMatch ? hlsMatch[1] : null;

  log('details hls', hls ? 'FOUND: ' + hls : 'none');
  return hls;
}

async function bruteSlug(http, title, year) {
  const slug = `${slugify(title)}-${year}`;
  log('brute', slug);
  try {
    const hls = await details(http, slug);
    return hls ? { slug, hls } : null;
  } catch { return null; }
}

/* ─── configurator HTML ─────────────────────────────────── */
const CONFIG_FORM=`<!DOCTYPE html><meta charset=utf-8>
<title>Puzzle-Movies → Stremio</title>
<style>body{font-family:sans-serif;max-width:460px;margin:2rem auto}</style>
<h2>Puzzle-Movies → Stremio</h2>
<p>Paste your <code>Cookie</code> header from puzzle-movies.com</p>
<form id=f><textarea name=cookies required rows=4 style="width:100%"></textarea>
<br><br><button>Generate link</button></form>
<p id=o style="word-break:break-all;margin-top:1.5rem"></p>
<script>
f.onsubmit=e=>{
 e.preventDefault();
 const tok=btoa(unescape(encodeURIComponent(JSON.stringify({
  cookies:f.cookies.value.trim()
 })))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
 o.textContent=location.origin+'/'+tok+'/manifest.json';
};
</script>`;

/* ─── HTTP router ───────────────────────────────────────── */
export default async function handler(req,res){
  const { pathname, searchParams } = new URL(req.url,'http://x');

  if(req.method==='OPTIONS') return res.writeHead(204,CORS).end();

  if(pathname==='/')
    return res.writeHead(200,{'content-type':'text/html'}).end(CONFIG_FORM);

  const parts=pathname.split('/').filter(Boolean);
  let cfg;
  if(parts.length&&!['manifest.json','catalog','meta','stream'].includes(parts[0])){
    try{ cfg=b64(parts.shift()); }catch{}
  }
  if(!cfg?.cookies) return send(res,400,{err:'missing cookies'});
  const http=makeHttp(cfg.cookies);

  if(/^manifest(\.json)?$/.test(parts[0]||''))
    return send(res,200,MANIFEST);

  if(parts[0]==='catalog'){
    const term=(searchParams.get('search')||'').trim();
    const m=/(\d{4})$/.exec(term); const year=m?Number(m[1]):undefined;
    const title=year?term.replace(/\d{4}$/,'').trim():term;
    let metas = [];
    if(year) {
      const hit = await search(http, title, year);
      if(hit)
        metas = [{ id:`puzzle:${hit.slug}`, type:'movie', name:hit.title }];
    }
    return send(res,200,{metas});
  }

  const clean=x=>x?.replace(/\.json$/i,'');
  const orig=clean(parts[2]);

  if(parts[0]==='meta'){
    log('/meta',orig);
    if(orig.startsWith('puzzle:')){
      const hls=await details(http,orig.slice(7));
      return send(res,200,{ meta:{ id:orig,type:'movie',name:orig,hls } });
    }
    const cm=await fetchCinemeta(orig);
    if(!cm) return send(res,200,{meta:{}});
    const hit=await search(http,cm.name,cm.year);
    let slug=hit?.slug;
    let hls=null;
    if(slug) hls=await details(http,slug);
    if(!hls){
      const brute=await bruteSlug(http,cm.name,cm.year);
      slug=brute?.slug; hls=brute?.hls;
    }
    return send(res,200,{ meta:{ id:orig,type:'movie',name:cm.name,hls } });
  }

  if(parts[0]==='stream'){
    log('/stream',orig);
    let slug=orig.startsWith('puzzle:')?orig.slice(7):null;
    let hls=null;
    if(!slug){
      const cm=await fetchCinemeta(orig);
      if(cm){
        const hit=await search(http,cm.name,cm.year);
        slug=hit?.slug;
        if(slug) hls=await details(http,slug);
        if(!hls){
          const brute=await bruteSlug(http,cm.name,cm.year); slug=brute?.slug; hls=brute?.hls;
        }
      }
    } else hls=await details(http,slug);
    return send(res,200,{ streams:hls?[{ url:hls,title:'Puzzle-Movies (HLS)', isFree:true }]:[] });
  }

  send(res,404,{err:'not found'});
}

/* ─── send helper ──────────────────────────────────────── */
function send(res,code,obj){
  res.writeHead(code,{ ...CORS, 'content-type':'application/json' });
  res.end(JSON.stringify(obj));
}
