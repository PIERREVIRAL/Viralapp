// Viralapp — Backend (Node + Express + FFmpeg)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { mkdirSync, existsSync, createWriteStream, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import ytdl from 'ytdl-core';
import { YoutubeTranscript } from 'youtube-transcript';
import Sentiment from 'sentiment';
import ffmpegCore from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';

// ---- FFmpeg paths
if (ffmpegPath) ffmpegCore.setFfmpegPath(ffmpegPath);
if (ffprobePath && ffprobePath.path) ffmpegCore.setFfprobePath(ffprobePath.path);
const ffmpeg = ffmpegCore;

const app = express();
app.use(cors());
app.use(express.json());

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---- Static frontend (serve /backend/public)
app.use(express.static(join(__dirname, 'public')));

// Healthcheck
app.get('/health', (_req, res) => res.send('OK'));

// Accueil -> index.html
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ---- Storage paths
const DATA_DIR = join(__dirname, 'data');
const OUTPUT_DIR = join(DATA_DIR, 'outputs');
const UPLOAD_DIR = join(__dirname, 'uploads');
[DATA_DIR, OUTPUT_DIR, UPLOAD_DIR].forEach(p => { if (!existsSync(p)) mkdirSync(p, { recursive: true }); });

// ---- Tiny DB (JSON file)
const DB_PATH = join(DATA_DIR, 'projects.json');
function readDB() {
  if (!existsSync(DB_PATH)) writeFileSync(DB_PATH, JSON.stringify({ projects: [] }, null, 2));
  return JSON.parse(readFileSync(DB_PATH, 'utf8'));
}
function writeDB(db) { writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
function upsertProject(p) {
  const db = readDB();
  const i = db.projects.findIndex(x => x.id === p.id);
  if (i >= 0) db.projects[i] = p; else db.projects.push(p);
  writeDB(db);
}
function getProject(id) {
  const db = readDB();
  return db.projects.find(p => p.id === id);
}

// ---- Utils
const upload = multer({ dest: UPLOAD_DIR });
const log = (...a)=>console.log('[viralapp]',...a);
const sentiment = new Sentiment();
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const FONT_LINUX = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

// ---- Highlight picker
function pickHighlights(segments, n = 3) {
  const KEYWORDS = [/incroyable|astuce|secret|erreur|gagne|viral|tendance|conseil|méthode|stratégie|top/i];
  const scored = segments.map(s => {
    const words = s.text.split(/\s+/).filter(Boolean);
    const dur = Math.max(s.end - s.start, 0.4);
    const wps = words.length / dur;
    const sent = Math.max(0, sentiment.analyze(s.text).comparative + 1);
    const kw = KEYWORDS.some(rx => rx.test(s.text)) ? 1.4 : 1.0;
    return { ...s, score: wps * sent * kw };
  }).sort((a,b)=>a.start-b.start);

  const merged = [];
  for (const s of scored) {
    const last = merged[merged.length-1];
    if (last && s.start - last.end < 0.6) { last.end = s.end; last.text += ' ' + s.text; last.score = Math.max(last.score, s.score); }
    else merged.push({ ...s });
  }
  for (const c of merged) {
    const d = c.end - c.start;
    if (d < 8) c.end = c.start + Math.min(8, d + 4);
    if (d > 20) c.end = c.start + 20;
  }
  const top = merged.sort((a,b)=>b.score-a.score).slice(0, n);
  for (let i=1;i<top.length;i++) if (top[i].start < top[i-1].end + 0.5) top[i].start = top[i-1].end + 0.5;
  return top;
}

// ---- YouTube helpers
async function downloadYouTube(url) {
  const info = await ytdl.getInfo(url);
  const format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
  const tempPath = join(UPLOAD_DIR, `${randomUUID()}.mp4`);
  await new Promise((res, rej) => {
    ytdl.downloadFromInfo(info, { quality: format.itag })
      .pipe(createWriteStream(tempPath)).on('finish', res).on('error', rej);
  });
  const normalized = join(UPLOAD_DIR, `${randomUUID()}.mp4`);
  await new Promise((res, rej) => {
    ffmpeg(tempPath).videoCodec('libx264').audioCodec('aac')
      .outputOptions(['-movflags +faststart','-preset veryfast','-crf 23'])
      .save(normalized).on('end', res).on('error', rej);
  });
  return { path: normalized };
}
async function getTranscript(url) {
  try {
    const items = await YoutubeTranscript.fetchTranscript(url, { lang: 'fr' }).catch(() => YoutubeTranscript.fetchTranscript(url));
    return items.map(i => ({ start: i.offset/1000, end: (i.offset+i.duration)/1000, text: i.text }));
  } catch { return []; }
}
async function probeDuration(path) {
  return await new Promise((resolve) => {
    ffmpeg.ffprobe(path, (err, data) => resolve(Number(data?.format?.duration || 0)));
  });
}

// ---- Video ops
async function makeVerticalClip(input, start, end) {
  const out = join(UPLOAD_DIR, `${randomUUID()}.mp4`);
  const filter =
    "[0:v]scale=1080:-2,boxblur=40:8,scale=1080:1920:force_original_aspect_ratio=cover[bg];" +
    "[0:v]scale=1080:-2,setsar=1[fg];" +
    "[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1[v]";
  await new Promise((res, rej) => {
    ffmpeg(input).setStartTime(start).duration(Math.max(0.2,end-start))
      .videoFilters(filter).audioFilters("loudnorm=I=-16:LRA=11:TP=-1.5").size("1080x1920")
      .outputOptions(['-map','[v]','-map','0:a?','-r','30','-preset','veryfast','-crf','22','-movflags','+faststart'])
      .save(out).on('end', res).on('error', rej);
  });
  return out;
}
async function concatClips(clips) {
  const out = join(OUTPUT_DIR, `${randomUUID()}.mp4`);
  await new Promise((res, rej) => {
    const cmd = ffmpeg(); clips.forEach(c=>cmd.input(c));
    cmd.videoCodec('libx264').audioCodec('aac')
      .outputOptions(['-filter_complex',`concat=n=${clips.length}:v=1:a=1[v][a]`,'-map','[v]','-map','[a]','-preset','veryfast','-crf','22','-movflags','+faststart'])
      .save(out).on('end', res).on('error', rej);
  });
  return out;
}

// ---- VO3 generator
async function createVO3Video({ script, perLineSec=2.5, bgColor='0x111827', textColor='white', fontSize=60 }, bgmPath=null) {
  const lines = String(script||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).slice(0,40);
  if (!lines.length) throw new Error('Script vide');
  const total = Math.max(3, Math.round(perLineSec * lines.length));
  const esc = (s) => s.replace(/:/g,'\\:').replace(/'/g,"\\'").replace(/\[/g,'\\[').replace(/\]/g,'\\]').replace(/%/g,'\\%');

  let vf = `[0:v]zoompan=z='min(zoom+0.0015,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=30*${total}[v0]`;
  let last='v0', chain=[];
  for (let i=0;i<lines.length;i++){
    const t0=(i*perLineSec).toFixed(2), t1=((i+1)*perLineSec-0.2).toFixed(2);
    const label=`v${i+1}`;
    const dt=`drawtext=fontfile=${FONT_LINUX}:text='${esc(lines[i])}':fontcolor=${textColor}:fontsize=${fontSize}:x=(w-text_w)/2:y=(h/2-text_h/2):box=1:boxcolor=black@0.35:boxborderw=30:shadowcolor=black:shadowx=2:shadowy=2:enable='between(t,${t0},${t1})'`;
    chain.push(`[${last}]${dt}[${label}]`); last=label;
  }
  const out = join(OUTPUT_DIR, `${randomUUID()}.mp4`);
  await new Promise((resolve, reject) => {
    const src = `color=${bgColor}:s=1080x1920:r=30:d=${total}`;
    ffmpeg().input(`lavfi:${src}`)
      .complexFilter(vf + (chain.length?`;${chain.join(';')}`:''), `[v${lines.length}]`)
      .outputOptions(['-map',`[v${lines.length}]`,'-t',String(total),'-r','30','-preset','veryfast','-crf','22','-movflags','+faststart'])
      .save(out)
      .on('end', async () => {
        if (!bgmPath) return resolve();
        const mixed = join(OUTPUT_DIR, `${randomUUID()}.mp4`);
        ffmpeg().input(out).input(bgmPath).audioFilters('dynaudnorm=f=150:g=31,volume=0.6').videoCodec('copy').outputOptions(['-shortest','-movflags','+faststart']).save(mixed)
          .on('end', () => { try { writeFileSync(out, readFileSync(mixed)); } catch{} resolve(); })
          .on('error', reject);
      })
      .on('error', reject);
  });
  return out;
}

// ---- API routes
app.post('/upload-video', upload.single('file'), async (req, res) => {
  try {
    const id = randomUUID();
    const youtube = req.body.youtube_link;
    const project = { id, status:'idle', progress:0, source:{ type: youtube ? 'youtube' : 'file', youtubeUrl: youtube || undefined, path: req.file?.path }, outputPath:null, meta:{} };
    upsertProject(project);
    res.json({ projectId:id });
  } catch(e){ log('upload error', e); res.status(500).json({ error:'upload_failed' }); }
});

app.post('/process-video', async (req, res) => {
  const id = String(req.query.projectId || '');
  const project = getProject(id);
  if (!project) return res.status(404).json({ error:'project_not_found' });
  res.json({ ok:true });

  (async ()=>{
    try{
      project.status='processing'; project.progress=1; upsertProject(project);
      let inputPath = project.source.path;
      if (project.source.type==='youtube'){
        project.progress=5; upsertProject(project);
        const dl = await downloadYouTube(project.source.youtubeUrl);
        inputPath = dl.path;
      }
      project.progress=15; upsertProject(project);
      let segments = [];
      if (project.source.youtubeUrl) segments = await getTranscript(project.source.youtubeUrl);
      const durationSec = await probeDuration(inputPath);
      project.meta.durationSec = durationSec;
      if (!segments.length) segments = Array.from({length: Math.floor(durationSec/10)}, (_,i)=>({ start:i*10, end: Math.min(durationSec, i*10+10), text:' ' }));
      const clipsMeta = pickHighlights(segments, 3);

      project.progress=45; upsertProject(project);
      const clipPaths=[];
      for (let i=0;i<clipsMeta.length;i++){
        const c=clipsMeta[i];
        project.progress = clamp(45 + i*15, 45, 85); upsertProject(project);
        clipPaths.push(await makeVerticalClip(inputPath, c.start, c.end));
      }
      project.progress=90; upsertProject(project);
      const output = await concatClips(clipPaths);

      project.outputPath = output; project.progress=100; project.status='done'; upsertProject(project);
      log('YT pipeline done',{id,output});
    }catch(err){ log('process error',err); project.status='error'; project.error=String(err?.message||err); upsertProject(project); }
  })();
});

app.get('/status', (req,res)=> {
  const id = String(req.query.projectId||''); const p = getProject(id);
  if (!p) return res.status(404).json({ error:'project_not_found' });
  res.json({ progress:p.progress||0, done: p.status==='done', status:p.status, error:p.error||null });
});

app.get('/export', (req,res)=>{
  const id = String(req.query.videoId||''); const p = getProject(id);
  if (!p || !p.outputPath || !existsSync(p.outputPath)) return res.status(404).json({ error:'not_ready' });
  res.download(p.outputPath, `reel_${id}.mp4`);
});

app.post('/vo3', upload.single('bgm'), async (req,res)=>{
  const id = randomUUID();
  const script = (req.body.script||'').toString();
  const perLineSec = Number(req.body.perLineSec||2.5);
  const bgColor = (req.body.bgColor||'0x111827').toString();
  const textColor = (req.body.textColor||'white').toString();
  const fontSize = Number(req.body.fontSize||60);
  const bgmPath = req.file ? req.file.path : null;

  const project = { id, status:'processing', progress:3, source:{ type:'vo3', script }, outputPath:null, meta:{ kind:'vo3' } };
  upsertProject(project); res.json({ projectId:id });

  (async()=>{ try{
    project.progress=10; upsertProject(project);
    const out = await createVO3Video({ script, perLineSec, bgColor, textColor, fontSize }, bgmPath);
    project.progress=100; project.status='done'; project.outputPath=out; upsertProject(project);
    log('VO3 done',{id,out});
  }catch(e){ project.status='error'; project.error=String(e?.message||e); upsertProject(project); log('VO3 error',e); }})();
});

// Serve generated outputs
app.use('/outputs', express.static(OUTPUT_DIR));

// ---- Start server
app.listen(PORT, ()=>log(`API running on :${PORT}`));
