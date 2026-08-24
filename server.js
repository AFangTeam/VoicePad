//
//  server.js —— VoicePad 的本地服务
//
//  零依赖，只用 Node 标准库。三件事：
//    1. 静态文件
//    2. 按目录列出视频 + 按 Range 流式提供给 <video>
//    3. 调系统 ffmpeg 导出（画面直通，只换音轨）
//
//  ## 为什么是「服务端列目录」而不是上传
//
//  浏览器的 <input type=file> 拿不到真实路径，所以要么把文件传上来，
//  要么让服务端自己去找。4K 素材动辄几个 GB，上传一遍再导出一遍等于
//  白白多写一份磁盘。所以这里让用户填目录，服务端直接就地读、就地导。
//
//  ## 为什么画面能"直通"
//
//  导出用 `-c:v copy`：视频流一个字节都不重编码，直接搬过去，
//  只把音轨换成滤波后的。所以导出很快（几 GB 也就几秒），
//  而且画质**零损失** —— 重编码一遍再交付是不可接受的。
//

import { createServer } from 'http';
import { createReadStream, createWriteStream, statSync, readdirSync, existsSync, mkdirSync, rmSync } from 'fs';
import { spawn, execFile } from 'child_process';
import { pipeline } from 'stream/promises';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { extname, join, resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = Number(process.env.PORT || 5178);

// 拖放进来的文件浏览器不给绝对路径（`File.path` 是 Electron 才有的），
// 所以只能先上传到这里，再由 ffmpeg 就地处理。
const UPLOAD_DIR = join(tmpdir(), 'voicepad-uploads');
// 上传来的素材没有"源文件夹"可言，导出统一落这里
const DROP_OUTPUT_DIR = join(homedir(), 'Movies', 'VoicePad');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.mts', '.m2ts', '.webm']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ── 工具 ────────────────────────────────────────────────────

const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function ffprobeDuration(path) {
  return new Promise((ok) => {
    execFile('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', path,
    ], (err, stdout) => ok(err ? null : Number(stdout.trim()) || null));
  });
}

// ── 列目录 ──────────────────────────────────────────────────

async function listVideos(dir) {
  const root = resolve(expand(dir));
  if (!existsSync(root)) throw new Error(`目录不存在：${root}`);
  const st = statSync(root);
  if (!st.isDirectory()) throw new Error(`不是目录：${root}`);

  const names = readdirSync(root)
    // 排掉自己的导出产物 —— 否则它们会出现在素材列表里被再导一遍，
    // 变成 _voicepad_voicepad，而且是对已经处理过的音轨二次 EQ
    .filter((n) => !n.startsWith('.')
      && VIDEO_EXT.has(extname(n).toLowerCase())
      && !basename(n, extname(n)).endsWith('_voicepad'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans'));

  // 时长逐个探，但并发起来 —— 一个目录几十条时串行会等很久
  const out = await Promise.all(names.map(async (name) => {
    const full = join(root, name);
    const s = statSync(full);
    return {
      name,
      path: full,
      size: s.size,
      duration: await ffprobeDuration(full),
    };
  }));
  return { dir: root, files: out };
}

// ── 流式提供视频（<video> 需要 Range）────────────────────────

function streamMedia(req, res, path) {
  const p = resolve(expand(path));
  if (!existsSync(p)) return json(res, 404, { error: '文件不存在' });

  const size = statSync(p).size;
  const type = extname(p).toLowerCase() === '.webm' ? 'video/webm' : 'video/mp4';
  const range = req.headers.range;

  // 没有 Range 就整条给。有 Range 必须回 206，否则 Safari 不给拖进度条
  if (!range) {
    res.writeHead(200, {
      'Content-Length': size,
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
    });
    return createReadStream(p).pipe(res);
  }

  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Number(m[2]) : size - 1;
  if (start >= size || end >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': type,
  });
  createReadStream(p, { start, end }).pipe(res);
}

// ── 导出 ────────────────────────────────────────────────────

/**
 * 画面直通、音轨替换。
 *
 * `-c:v copy` = 视频流原样搬运，零重编码零画质损失。
 * 音频编码成 AAC 256k —— 已经过了一遍 EQ，再用低码率会把刚调好的高频毁掉。
 *
 * 输出到源文件旁边的 `<原名>_voicepad.<后缀>`，**不覆盖原文件**。
 */
function exportOne(input, filter, onProgress, opts = {}) {
  return new Promise((ok, fail) => {
    const ext = extname(input);
    const stem = (opts.displayName ? basename(opts.displayName, extname(opts.displayName))
                                   : basename(input, ext));
    const dir = opts.outDir || dirname(input);
    mkdirSync(dir, { recursive: true });

    // 重名不覆盖：追加 _1 / _2。批量跑两遍不该悄悄盖掉上一次的成果
    let out = join(dir, `${stem}_voicepad${ext}`);
    let n = 1;
    while (existsSync(out)) out = join(dir, `${stem}_voicepad_${n++}${ext}`);

    const args = [
      '-y', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats',
      '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'copy',
      // 单声道素材也要能用 pan=stereo，先统一升成立体声
      '-af', `aformat=channel_layouts=stereo,${filter}`,
      '-c:a', 'aac', '-b:a', '256k',
      // mov/mp4 把索引挪到头部，边下边播更友好
      '-movflags', '+faststart',
      out,
    ];

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stdout.on('data', (chunk) => {
      const m = /out_time_ms=(\d+)/.exec(chunk.toString());
      if (m) onProgress?.(Number(m[1]) / 1e6);
    });
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => {
      if (code === 0) ok(out);
      else fail(new Error(stderr.trim().split('\n').pop() || `ffmpeg 退出码 ${code}`));
    });
    ff.on('error', () => fail(new Error('找不到 ffmpeg。请先安装：brew install ffmpeg')));
  });
}

/** 批量导出，用 SSE 逐条回报进度 */
async function handleExport(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;

  let payload;
  try { payload = JSON.parse(body); }
  catch { return json(res, 400, { error: '请求格式有误' }); }

  const { files, filter } = payload;
  if (!Array.isArray(files) || !files.length) return json(res, 400, { error: '没有要导出的素材' });
  if (typeof filter !== 'string' || !filter) return json(res, 400, { error: '缺少音频滤镜' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    send({ type: 'start', index: i, name: f.name || basename(f.path) });
    try {
      // 每条素材用自己的滤镜串（批量粘贴后各条可能不同），
      // 没带就退回整单的那一条
      const out = await exportOne(f.path, f.filter || filter, (sec) => {
        send({ type: 'progress', index: i, seconds: sec, duration: f.duration || null });
      }, {
        // 上传来的素材没有源文件夹，统一落 ~/Movies/VoicePad
        outDir: f.uploaded ? DROP_OUTPUT_DIR : undefined,
        displayName: f.name,
      });
      send({ type: 'done', index: i, output: out });
      // 临时上传件用完即删，不留几个 GB 在 /tmp 里
      if (f.uploaded) { try { rmSync(f.path, { force: true }); } catch { /* 忽略 */ } }
    } catch (e) {
      send({ type: 'error', index: i, message: e.message });
      if (f.uploaded) { try { rmSync(f.path, { force: true }); } catch { /* 忽略 */ } }
    }
  }
  send({ type: 'all-done' });
  res.end();
}

// ── 缩略图 ──────────────────────────────────────────────────

/**
 * 抽一帧当特征图。
 *
 * 服务端用 ffmpeg 抽而不是让浏览器 <video>+canvas 抓：
 * 一条胶片条上几十个缩略图，浏览器那边等于同时开几十个解码会话，
 * 会和正在播放的预览抢硬解码器，整个页面一起卡。
 *
 * 取 10% 处而不是第 0 帧 —— 开头常是黑场或对焦未完成。
 * 结果按 (路径, mtime, 尺寸) 缓存在内存里，同一条不会重复抽。
 */
const thumbCache = new Map();
const THUMB_MAX = 300;

function thumbnail(path, width = 256) {
  return new Promise((ok, fail) => {
    let st;
    try { st = statSync(path); } catch { return fail(new Error('文件不存在')); }
    const key = `${path}|${st.mtimeMs}|${width}`;
    if (thumbCache.has(key)) return ok(thumbCache.get(key));

    const dur = null;
    const args = [
      '-v', 'error',
      // 先 seek 再解码（输入前的 -ss 是关键帧快进，几个 GB 也是瞬时）
      '-ss', '1',
      '-i', path,
      '-frames:v', '1',
      '-vf', `scale=${width}:-2`,
      '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '4',
      'pipe:1',
    ];
    const ff = spawn('ffmpeg', args);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', () => fail(new Error('找不到 ffmpeg')));
    ff.on('close', (code) => {
      const buf = Buffer.concat(chunks);
      if (code !== 0 || !buf.length) {
        // 1 秒处取不到（素材短于 1 秒）就退回第 0 帧
        const ff2 = spawn('ffmpeg', ['-v','error','-i',path,'-frames:v','1',
          '-vf',`scale=${width}:-2`,'-f','image2','-c:v','mjpeg','-q:v','4','pipe:1']);
        const c2 = [];
        ff2.stdout.on('data', (c) => c2.push(c));
        ff2.on('close', (code2) => {
          const b2 = Buffer.concat(c2);
          if (code2 !== 0 || !b2.length) return fail(new Error('无法生成缩略图'));
          cacheThumb(key, b2); ok(b2);
        });
        ff2.on('error', () => fail(new Error('无法生成缩略图')));
        return;
      }
      cacheThumb(key, buf);
      ok(buf);
    });
  });
}

function cacheThumb(key, buf) {
  thumbCache.set(key, buf);
  while (thumbCache.size > THUMB_MAX) {
    thumbCache.delete(thumbCache.keys().next().value);
  }
}

// ── 上传（拖放进来的素材）─────────────────────────────────────

/**
 * 把请求体直接流式落盘。
 *
 * 不用 multipart —— 那要么引依赖要么自己写解析器，而这里只需要传一个文件。
 * 文件名放在头里，正文就是裸字节，服务端 pipe 到临时文件即可，
 * 内存占用恒定，几个 GB 也不会撑爆。
 */
async function handleUpload(req, res) {
  const raw = req.headers['x-filename'];
  if (!raw) return json(res, 400, { error: '缺少文件名' });

  let name;
  try { name = basename(decodeURIComponent(raw)); }
  catch { return json(res, 400, { error: '文件名编码有误' }); }

  const ext = extname(name).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return json(res, 400, { error: `不支持的格式：${ext || '(无扩展名)'}` });

  mkdirSync(UPLOAD_DIR, { recursive: true });
  const dest = join(UPLOAD_DIR, `${randomUUID()}${ext}`);

  try {
    await pipeline(req, createWriteStream(dest));
  } catch (e) {
    try { rmSync(dest, { force: true }); } catch { /* 忽略 */ }
    return json(res, 500, { error: `上传失败：${e.message}` });
  }

  return json(res, 200, {
    path: dest,
    name,
    size: statSync(dest).size,
    duration: await ffprobeDuration(dest),
    uploaded: true,
  });
}

// ── 路由 ────────────────────────────────────────────────────

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = join(PUBLIC, rel.replace(/\.\./g, ''));
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    // 本地开发工具，禁缓存 —— 改完样式刷新看不到新效果比慢一点更糟
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/browse') {
      const dir = url.searchParams.get('dir');
      if (!dir) return json(res, 400, { error: '缺少目录' });
      return json(res, 200, await listVideos(dir));
    }
    if (url.pathname === '/api/media') {
      const p = url.searchParams.get('path');
      if (!p) return json(res, 400, { error: '缺少路径' });
      return streamMedia(req, res, p);
    }
    if (url.pathname === '/api/thumb') {
      const p = url.searchParams.get('path');
      if (!p) return json(res, 400, { error: '缺少路径' });
      try {
        const buf = await thumbnail(resolve(expand(p)));
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': buf.length,
          // 缩略图按内容缓存在服务端了，浏览器这边也让它存一会儿
          'Cache-Control': 'private, max-age=600',
        });
        return res.end(buf);
      } catch (e) {
        return json(res, 404, { error: e.message });
      }
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      return await handleUpload(req, res);
    }
    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const p = url.searchParams.get('path');
      if (p && existsSync(p)) execFile('open', ['-R', p], () => {});
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/export' && req.method === 'POST') {
      return await handleExport(req, res);
    }
    return serveStatic(res, url.pathname);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

// 启动时清一次上传暂存区。
// 导出成功/失败都会删自己那份，但用户中途关页面的那些会留下来 ——
// 几个 GB 的视频堆在 /tmp 里不清就是纯浪费。
try {
  if (existsSync(UPLOAD_DIR)) rmSync(UPLOAD_DIR, { recursive: true, force: true });
} catch { /* 忽略 */ }

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  VoicePad  →  http://localhost:${PORT}\n`);
  console.log('  只监听 127.0.0.1，不对外网开放。Ctrl+C 停止。\n');
});
