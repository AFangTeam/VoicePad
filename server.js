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
import { platform } from 'process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
// PORT=0 lets the macOS app request a free local port for its private server.
const PORT = process.env.PORT === undefined ? 5178 : Number(process.env.PORT);

// 拖放进来的文件浏览器不给绝对路径（`File.path` 是 Electron 才有的），
// 所以只能先上传到这里，再由 ffmpeg 就地处理。
const UPLOAD_DIR = join(tmpdir(), 'voicepad-uploads');

// 导出统一到 48k：EQ 系数和对轨采样数都按这个率算，预览和导出才落在同一网格
const ALIGN_RATE = 48000;
// 上传来的素材没有"源文件夹"可言，导出统一落这里
const DROP_OUTPUT_DIR = join(homedir(), platform === 'darwin' ? 'Movies' : 'Videos', 'VoicePad');

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.mts', '.m2ts', '.webm']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ── 工具 ────────────────────────────────────────────────────

const expand = (p) => {
  // Windows “Copy as path” often includes quotes; accept those in folder mode.
  const clean = p.trim().replace(/^("(.*)"|'(.*)')$/, (_, _quoted, double, single) => double ?? single);
  if (clean === '~') return homedir();
  return /^~[\\/]/.test(clean) ? join(homedir(), clean.slice(2)) : clean;
};

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
async function exportOne(input, filter, onProgress, opts = {}) {
  // 单声道素材没有"两条声道"可对。批量粘贴甜点值时,一条混在里面的单声道素材
  // 会被 aformat 升成两条一模一样的声道 —— 再延迟其中一条求和,就是自己和自己
  // 打梳状滤波,把好好的声音毁掉。这里直接把对轨段摘掉。
  const info = await probeAudio(input);
  if (info && info.channels < 2) {
    filter = filter.replace(/^adelay=[^,]+,(atrim=[^,]+,asetpts=[^,]+,)?/, '');
  }

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
      '-af', `aresample=48000,aformat=channel_layouts=stereo,${filter}`,
      // 滤镜链开头先重采样到 48k。仅设置输出 -ar 会在 biquad 之后重采样，
      // 44.1k 素材仍会用错系数和对轨采样数。
      '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
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
    ff.on('error', () => fail(new Error('找不到 ffmpeg。请安装 ffmpeg，并将其加入 PATH')));
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
        // 上传来的素材没有源文件夹，统一落用户的视频目录下
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


// ── 声道对轨分析 ────────────────────────────────────────────
//
// ## 为什么不是"通用对齐算法"
//
// 通用的音频对齐要处理"两段素材可能差几分钟、可能根本不重叠"，
// 所以得先做指纹、再做搜索。这里的前提强得多：**同一次录音的两条声道**，
// 差值必定很小（麦距 + 无线链路延迟，现实里 0~50ms，给到 500ms 已是天花板）。
//
// 把这个上界用足，复杂度就塌下来了：
//
//   粗定位  降到 8kHz（人声能量本来就在 3.4k 以下），滞后只搜 ±4000 采样。
//           一次 131072 点的 FFT 就够，而不是全长全率的相关。
//   精定位  粗定位已经把答案锁进 ±1 个 8k 采样，换算到 48k 就是 ±6。
//           在这 ±12 采样的窗口里做**直接**互相关 —— 25 个滞后 × 一段样本，
//           几百万次乘加，比再做一次全长 FFT 便宜得多。
//
// 粗定位用 GCC-PHAT（互功率谱只留相位）。两支麦音色差很远时，普通互相关
// 会被低频那点共同的隆隆声带跑偏；PHAT 把每个频点的幅度拉平，只信相位，
// 峰值又尖又准。再把权重限制在 150–3400Hz，避开风噪和嘶声。

/** 就地 radix-2 FFT。实部虚部分开存，避免复数对象的分配开销 */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k], ui = im[i + k];
        const jr = re[i + k + half], ji = im[i + k + half];
        const vr = jr * cr - ji * ci;
        const vi = jr * ci + ji * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * 一次打开文件，同时拿到 8k 和 48k 两路 PCM。
 *
 * ## 为什么是这个形状
 *
 * 实测（833MB 的 4K 素材）：开文件 203ms，开完再解 0.2 秒 204ms，解 20 秒 206ms。
 * **解码几乎免费，代价全在打开容器、解析索引表。** 所以优化方向不是"少解一点"，
 * 而是"少开几次文件"：
 *
 *   -probesize 32k -analyzeduration 0   默认参数会为了探测编码去读几 MB 的 4K
 *                                       视频数据。我们只要音轨，探测可以极简。
 *                                       实测 207ms → 32ms
 *   两路输出（pipe:1 / pipe:3）          8k 给粗定位、48k 给精定位，一次开文件
 *                                       全拿到，重采样交给 ffmpeg 的 C 实现。
 *                                       原来这是两次独立调用 = 两次开文件
 */
function extractDual(input, startSec, durSec) {
  return new Promise((ok, fail) => {
    const args = ['-v', 'error', '-nostdin', '-probesize', '32k', '-analyzeduration', '0'];
    if (startSec > 0) args.push('-ss', String(startSec));
    args.push('-t', String(durSec), '-i', input, '-vn', '-sn', '-dn');
    for (const [rate, target] of [[8000, 'pipe:1'], [48000, 'pipe:3']]) {
      args.push('-map', '0:a:0', '-ac', '2', '-ar', String(rate));
      // ⚠️ 48k 这一路是给精定位用的，必须带通。
      //
      // 粗定位的 GCC-PHAT 只在 150–3400Hz 加权，精定位却是直接算归一化互相关。
      // 拿宽带信号算，两支音色差很远的麦（一支机头麦、一支小蜜蜂 —— 这个工具的
      // 常态）在低频隆隆声和高频嘶声上根本不相关，那些能量会灌进相关系数的分母
      // 把结果冲垮。
      //
      // 这一句在「一次开文件拿两种采样率」那次提速里被弄丢了（d75fded），
      // 之后 Cubic 和 AU 插件都是从丢了之后的版本移植的，三处一起中招。
      // 实测素材 C4899：宽带相关只有 +0.066，峰还选错到 −22.0ms、符号也反了；
      // 带通回来之后 +0.237，峰回到 −23.25ms。
      if (rate === 48000) args.push('-af', 'highpass=f=200,lowpass=f=6000');
      args.push('-c:a', 'pcm_f32le', '-f', 'f32le', target);
    }

    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const sink = (stream) => new Promise((done) => {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => done(Buffer.concat(chunks)));
      stream.on('error', () => done(Buffer.alloc(0)));
    });
    let err = '';
    ff.stderr.on('data', (d) => { err += d.toString(); });

    Promise.all([sink(ff.stdout), sink(ff.stdio[3])]).then(([b8, b48]) => {
      ff.on('close', (code) => {
        if (code !== 0 && !b8.length) {
          return fail(new Error(err.trim().split('\n').pop() || '解码失败'));
        }
        ok({ s8: deinterleave(b8), s48: deinterleave(b48) });
      });
    });
    ff.on('error', () => fail(new Error('找不到 ffmpeg')));
  });
}

/** 交错的 f32 裸流拆成两条声道。保持 Float32 —— FFT 那步会自己开 Float64 缓冲 */
function deinterleave(buf) {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const n = Math.floor(f32.length / 2);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = f32[2 * i]; R[i] = f32[2 * i + 1]; }
  return { L, R, n };
}

function energy(a, from, to) {
  let e = 0;
  for (let i = from; i < to; i++) e += a[i] * a[i];
  return e;
}

/** 一条声道的 RMS，用来区分"静音"和"双单声道" */
function channelRMS(a, n) {
  let sum = 0;
  const step = Math.max(1, Math.floor(n / 8192));
  let cnt = 0;
  for (let i = 0; i < n; i += step) { sum += a[i] * a[i]; cnt++; }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}

/** 两条声道逐样本相同 = 单声道素材被 -ac 2 复制成了两条，没有对轨的余地 */
function identicalChannels(L, R, n) {
  const step = Math.max(1, Math.floor(n / 4096));
  for (let i = 0; i < n; i += step) if (L[i] !== R[i]) return false;
  return true;
}

/** 粗定位：GCC-PHAT，语音带加权，滞后限制在 ±maxLagSec */
function coarseLag(L, R, rate, maxLagSec) {
  const n = L.length;
  const maxLag = Math.round(maxLagSec * rate);
  const size = 1 << Math.ceil(Math.log2(n + maxLag + 1));
  const ar = new Float64Array(size), ai = new Float64Array(size);
  const br = new Float64Array(size), bi = new Float64Array(size);
  ar.set(L); br.set(R);
  fft(ar, ai, false);
  fft(br, bi, false);

  const lo = Math.max(1, Math.round(150 / rate * size));
  const hi = Math.round(3400 / rate * size);
  const cr = new Float64Array(size), ci = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    const kk = k <= size / 2 ? k : size - k;
    if (kk < lo || kk > hi) continue;
    const xr = ar[k] * br[k] + ai[k] * bi[k];     // A · conj(B)
    const xi = ai[k] * br[k] - ar[k] * bi[k];
    const m = Math.hypot(xr, xi);
    if (m < 1e-12) continue;
    cr[k] = xr / m; ci[k] = xi / m;               // 只留相位
  }
  fft(cr, ci, true);

  // 按**绝对值**找峰：接反的线材会让整个相关翻个号，峰变成谷。
  // 但极性是机位的属性，不是每个滞后各有一份 —— 所以只在这里定一次
  let best = 0, peak = -Infinity, sign = 1;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const v = cr[(lag + size) % size];
    if (Math.abs(v) > peak) { peak = Math.abs(v); best = lag; sign = v < 0 ? -1 : 1; }
  }
  let bg = 0, cnt = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    if (Math.abs(lag - best) < Math.round(rate * 0.002)) continue;
    bg += Math.abs(cr[(lag + size) % size]); cnt++;
  }
  return { lag: best, sign, sharpness: cnt ? peak / (bg / cnt) : 0 };
}

/**
 * 精定位：在已知的小范围里做直接归一化互相关，抛物线插值到采样以下。
 * lag 为正 = 右声道比左声道**早**到，和 align 的符号一致。
 */
function fineLag(L, R, rate, centerLag, span, maxSec = 10, sign = 1, focus = null) {
  // 相关只用中间一段。互相关的代价是 滞后数 × 样本数，20 秒 @48k 就是
  // 3000 万次乘加（~60ms）；6 秒足够把峰值定到采样以下，而且贵得多的
  // 是"多算 14 秒"而不是"少一点精度"—— 实测误差仍是 0.00 采样
  const cap = Math.min(L.length, Math.round(maxSec * rate));
  // focus：到证据最强的那一窗去做精定位。取正中间是碰运气 —— 实测 C4899 的
  // 窗口正中间恰好是最差的一段，在那儿只拿到 0.047 的相关、值也偏了 0.3ms
  let off = Math.floor((L.length - cap) / 2);
  if (focus != null) off = Math.max(0, Math.min(L.length - cap, focus - Math.floor((cap - 4 * rate) / 2)));
  if (off > 0) { L = L.subarray(off, off + cap); R = R.subarray(off, off + cap); }

  const n = L.length;
  const scores = new Map();
  const corr = (lag) => {
    if (scores.has(lag)) return scores.get(lag);
    const from = Math.max(0, lag), to = Math.min(n, n + lag);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = from; i < to; i++) {
      const a = L[i], b = R[i - lag];
      sxy += a * b; sxx += a * a; syy += b * b;
    }
    const v = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
    scores.set(lag, v);
    return v;
  };
  // ⚠️ 这里必须用**有符号**相关（sign 由粗定位一次性定死），不能用 |corr|。
  // 人声有基频周期性，相关曲线在真峰旁边就有反号的旁瓣；窗口一短，
  // 旁瓣的绝对值可能盖过真峰 —— 实测真实素材上就这么跑偏了 1.2ms
  let best = centerLag, peak = -Infinity;
  for (let lag = centerLag - span; lag <= centerLag + span; lag++) {
    const v = sign * corr(lag);
    if (v > peak) { peak = v; best = lag; }
  }
  const y0 = sign * corr(best - 1), y1 = sign * corr(best), y2 = sign * corr(best + 1);
  const den = y0 - 2 * y1 + y2;
  const frac = den !== 0 ? (0.5 * (y0 - y2)) / den : 0;
  return { lag: best + (Math.abs(frac) <= 1 ? frac : 0), r: corr(best) };
}

const SEGMENTS = 3;          // 把窗口切成几段互相复核
const AGREE_TOL_8K = 4;      // 段间一致的容差（4 个 8k 采样 = 0.5ms）

/**
 * 主流程。三种走法，代价递增：
 *
 *   verify   已经知道同机位另一条素材的偏移量 → 只在它附近做直接相关，不做 FFT。
 *            一批素材里只有第一条需要真正"搜"，其余都是"验"。
 *   fast     取一段窗口切成 3 小段，各自独立定位，**两段以上对得上才采信**。
 *            既是复核也是置信度 —— 比单个相关系数诚实得多。
 *   wide     小段之间对不上（窗口里是静音、或两条声道压根不相关）才走这条：
 *            退回全片粗扫找有货的窗口。多两次开文件，但很少发生。
 */
async function analyzeAlign(input, opts = {}) {
  const duration = Number(opts.duration) || 0;
  // 起点躲开开头的板子/环境音；素材短就从头来
  const win = Math.min(32, duration > 0 ? Math.max(4, duration) : 32);
  const start = duration > win + 2 ? Math.min(duration * 0.1, duration - win) : 0;

  let { s8, s48 } = await extractDual(input, start, win);
  if (s8.n < 8000) ({ s8, s48 } = await extractDual(input, 0, Math.max(4, duration || 24)));
  if (s8.n < 4000) throw new Error('音频太短，不足以分析');
  // 静音和"双单声道"必须分开判：全零的两条声道当然"相等"，
  // 只做逐样本比较会把一段静音报成「单声道素材」
  if (channelRMS(s8.L, s8.n) < 3e-4 && channelRMS(s8.R, s8.n) < 3e-4) {
    throw new Error('这一段几乎是静音，先找一段有人说话的地方');
  }
  if (identicalChannels(s8.L, s8.R, s8.n)) {
    throw new Error('两条声道完全相同（双单声道），不需要对轨');
  }

  // ── verify：拿着假设去核对，不做 FFT ──
  if (opts.hint != null && Number.isFinite(opts.hint)) {
    const hint8 = Math.round((opts.hint / 1000) * 8000);
    // 极性跟着假设一起传进来（由第一条素材的全搜定的）。
    // 不在这里现场判：相关峰只有一个多采样宽，假设哪怕只差半毫秒，
    // 在假设点上量到的相关就已经掉到 0 附近，据此判极性会得到随机结果
    const sign = opts.sign < 0 ? -1 : 1;
    // 核对只看假设附近 ±3ms。偏出这个范围就不是"同一套机位的同一个偏移"了，
    // 该退回全搜，而不是把峰值找到天边去
    const near = fineLag(s8.L, s8.R, 8000, hint8, 24, 12, sign);
    const fine = fineLag(s48.L, s48.R, 48000, Math.round(near.lag * 6), 12, 10, sign);
    // 两个条件都要满足才算"验过了"：峰没跑远，而且确实是个峰
    return finish(fine, {
      mode: 'verify', sign,
      agreed: Math.abs(near.lag - hint8) <= AGREE_TOL_8K && Math.abs(fine.r) >= 0.12,
      drift: (near.lag - hint8) / 8000 * 1000,
      segments: 1, sharpness: 0,
    });
  }

  // ── fast：切段加权复核 ──
  const v = segmentVotes(s8);
  const sharp = v.reduce((a, x) => Math.max(a, x.sharpness), 0);
  const agreed = consensus(v, AGREE_TOL_8K);
  if (process.env.VP_DEBUG) {
    console.error('votes:', v.map(x => `${x.lag}(${x.sign > 0 ? '+' : '-'},${x.sharpness.toFixed(0)})`).join(' '),
                  '→', agreed ? `lag ${agreed.lag} sign ${agreed.sign} count ${agreed.count}` : 'null');
  }
  if (agreed) {
    const fine = fineLag(s48.L, s48.R, 48000, agreed.lag * 6, 16, 10, agreed.sign, agreed.focus * 6);
    return finish(fine, { mode: 'fast', agreed: true, segments: agreed.count,
                          sharpness: sharp, sign: agreed.sign });
  }

  return await wideAnalyze(input, duration);
}

/**
 * 找出彼此在容差内的一组，**按峰背比加权**选出最强的那组。
 *
 * ⚠️ 不能一段一票等权。峰背比说的是"这个滞后位置比背景突出多少"，也就是这一票
 * 有多可信：实测素材 C4899 里，找对答案的三段峰背比是 37/51/38，乱指的几段是
 * 13/21/23 —— 等权投票时后者能把前者压下去，于是达不成共识、掉进全片粗扫，
 * 最后拿回一个负号的假峰。
 */
function consensus(votes, tol) {
  if (votes.length < 2) return null;
  let best = null;
  for (const anchor of votes) {
    const group = votes.filter((v) => Math.abs(v.lag - anchor.lag) <= tol);
    if (group.length < 2) continue;
    const weight = group.reduce((a, v) => a + v.sharpness, 0);
    if (!best || weight > best.weight) {
      const lags = group.map((v) => v.lag).sort((a, b) => a - b);
      // 极性也按峰背比投票，别让一个弱段把符号带反
      const signWeight = group.reduce((a, v) => a + v.sign * v.sharpness, 0);
      // 精定位回到这组里峰背比最高的那一窗去做
      const focus = group.reduce((a, v) => (v.sharpness > a.sharpness ? v : a), group[0]).start;
      best = { lag: lags[Math.floor(lags.length / 2)], sign: signWeight >= 0 ? 1 : -1,
               count: group.length, weight, focus };
    }
  }
  return best;
}

/**
 * 把一段 8k 信号切成若干小段各自粗定位，每段投一票。
 * 段长盯着 8 秒走（太短则 ±500ms 搜索范围吃掉大半重叠区），段数夹在 3–8。
 */
function segmentVotes(s8) {
  const span = s8.n / 8000;
  const segSec = Math.max(4, Math.min(8, span / 3));
  const seg = Math.round(segSec * 8000);
  if (seg <= 8000 || s8.n < seg) return [];

  const MAX_VOTES = 16;
  let hop = Math.max(1, Math.floor(seg / 2));
  const after = s8.n - seg;
  if (after / hop > MAX_VOTES - 1) hop = Math.max(1, Math.floor(after / (MAX_VOTES - 1)));

  const starts = [];
  for (let st = 0; st + seg <= s8.n; st += hop) starts.push(st);
  if (!starts.length) return [];

  const es = starts.map((st) => Math.min(energy(s8.L, st, st + seg), energy(s8.R, st, st + seg)));
  const loudest = Math.max(...es);
  const out = [];
  starts.forEach((st, i) => {
    if (es[i] < loudest * 0.02) return;
    const c = coarseLag(s8.L.subarray(st, st + seg), s8.R.subarray(st, st + seg), 8000, 0.5);
    out.push({ lag: c.lag, sign: c.sign, sharpness: c.sharpness, start: st });
  });
  return out;
}

/** 兜底：全片 8k 粗扫，挑出两条声道都有货的窗口，再在那儿重跑一次 */
async function wideAnalyze(input, duration) {
  const span = Math.min(duration || 300, 300);
  const { s8 } = await extractDual(input, 0, span);
  if (s8.n < 8000) throw new Error('音频太短，不足以分析');

  const winLen = Math.min(s8.n, 12 * 8000);
  const step = 4000;
  let el = energy(s8.L, 0, winLen), er = energy(s8.R, 0, winLen);
  let bestStart = 0, bestScore = Math.min(el, er);
  for (let st = step; st + winLen <= s8.n; st += step) {
    el += energy(s8.L, st + winLen - step, st + winLen) - energy(s8.L, st - step, st);
    er += energy(s8.R, st + winLen - step, st + winLen) - energy(s8.R, st - step, st);
    const sc = Math.min(el, er);
    if (sc > bestScore) { bestScore = sc; bestStart = st; }
  }

  const c = coarseLag(s8.L.subarray(bestStart, bestStart + winLen),
                      s8.R.subarray(bestStart, bestStart + winLen), 8000, 0.5);
  const re = await extractDual(input, bestStart / 8000, winLen / 8000);
  const fine = fineLag(re.s48.L, re.s48.R, 48000, c.lag * 6, 16, 10, c.sign);
  return finish(fine, { mode: 'wide', agreed: false, segments: 1, sharpness: c.sharpness, sign: c.sign });
}

function finish(fine, meta) {
  return {
    ms: (fine.lag / 48000) * 1000,
    sign: meta.sign ?? 1,
    samples: fine.lag,
    correlation: fine.r,
    inverted: fine.r < 0,
    ...meta,
  };
}
/** 音轨的声道数 / 采样率。没有音轨返回 null */
function probeAudio(input) {
  return new Promise((ok) => {
    const ff = spawn('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=channels,sample_rate', '-of', 'json', input]);
    let out = '';
    ff.stdout.on('data', (d) => { out += d.toString(); });
    ff.on('close', () => {
      try {
        const st = JSON.parse(out).streams?.[0];
        ok(st ? { channels: Number(st.channels), rate: Number(st.sample_rate) } : null);
      } catch { ok(null); }
    });
    ff.on('error', () => ok(null));
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
  // A browser on another site must not drive this local file-processing API.
  // The Host check also rejects DNS rebinding names pointed at 127.0.0.1.
  const host = (req.headers.host || '').toLowerCase();
  const port = server.address()?.port;
  if (host !== `localhost:${port}` && host !== `127.0.0.1:${port}`) {
    return json(res, 403, { error: '只接受本机请求' });
  }
  const origin = req.headers.origin;
  if ((origin && origin.toLowerCase() !== `http://${host}`) ||
      req.headers['sec-fetch-site'] === 'cross-site') {
    return json(res, 403, { error: '不接受来自其他网页的请求' });
  }
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
    if (url.pathname === '/api/align') {
      const p = url.searchParams.get('path');
      if (!p) return json(res, 400, { error: '缺少路径' });
      // duration 让分析窗口能躲开片头；hint 是"同机位另一条已经测出的偏移量"，
      // 给了就只做核对，不做全范围搜索
      const hint = url.searchParams.has('hint') ? Number(url.searchParams.get('hint')) : null;
      const sign = Number(url.searchParams.get('sign')) || 1;
      const duration = Number(url.searchParams.get('dur')) || 0;
      try {
        return json(res, 200, await analyzeAlign(resolve(expand(p)), { hint, sign, duration }));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      return await handleUpload(req, res);
    }
    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const p = url.searchParams.get('path');
      if (p && existsSync(p)) {
        if (platform === 'darwin') execFile('open', ['-R', p], () => {});
        else if (platform === 'win32') execFile('explorer.exe', ['/select,', p], () => {});
        else execFile('xdg-open', [dirname(p)], () => {});
      }
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
  console.log(`\n  VoicePad  →  http://localhost:${server.address().port}\n`);
  console.log('  只监听 127.0.0.1，不对外网开放。Ctrl+C 停止。\n');
});
