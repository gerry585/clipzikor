require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

// Set ffmpeg path from @ffmpeg-installer if available and system ffmpeg is not explicitly set
let ffmpegBin = 'ffmpeg';
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller.path) {
    ffmpegBin = ffmpegInstaller.path;
    if (!process.env.FFMPEG_PATH) {
      ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    }
  }
} catch (e) {
  // Rely on system ffmpeg (e.g. in Docker)
}

if (process.env.FFMPEG_PATH) {
  ffmpegBin = process.env.FFMPEG_PATH;
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'cliphub-super-secret-key-12345';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/discord/callback`;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const BRAND_NAME = process.env.APP_NAME || 'ClipHub';

// Доступ к галерее и действиям — только участникам этого Discord-сервера
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '818193214120919130';

// Участники с этой ролью на сервере — администраторы: могут удалять любые клипы и комментарии,
// менять название и игру любого клипа
const DISCORD_ADMIN_ROLE_ID = process.env.DISCORD_ADMIN_ROLE_ID || '1565612451574186004';

// Как часто перепроверять в Discord, что человек всё ещё на сервере и сохранил (или потерял) роль админа
const MEMBER_RECHECK_MS = Number(process.env.MEMBER_RECHECK_SECONDS || 300) * 1000;

// Свои комментарии можно менять и удалять только в течение 24 часов после публикации
const COMMENT_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Категории игр (для редактирования клипа и фильтра галереи)
const GAME_OPTIONS = [
  'CS2', 'Dota 2', 'Valorant', 'Minecraft', 'Roblox', 'Palworld',
  'Apex Legends', 'GTA V', 'Rust', 'Lethal Company', 'Fortnite', 'Другое'
];

// Paths: Permanent storage for videos & thumbnails, dedicated temp outside uploads
const DATA_DIR = path.join(__dirname, 'data');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const THUMBNAILS_DIR = path.join(UPLOADS_DIR, 'thumbnails');
const TEMP_DIR = path.join(__dirname, 'temp');

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR, VIDEOS_DIR, THUMBNAILS_DIR, TEMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Initialize database file if missing
if (!fs.existsSync(CLIPS_FILE)) {
  fs.writeFileSync(CLIPS_FILE, JSON.stringify([], null, 2), 'utf-8');
}

// Database helper functions (atomic read & write)
function getClips() {
  try {
    const data = fs.readFileSync(CLIPS_FILE, 'utf-8');
    return JSON.parse(data || '[]');
  } catch (err) {
    console.error('Error reading clips database:', err);
    return [];
  }
}

function saveClips(clips) {
  try {
    const tmpFile = `${CLIPS_FILE}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(clips, null, 2), 'utf-8');
    fs.renameSync(tmpFile, CLIPS_FILE);
    return true;
  } catch (err) {
    console.error('Error writing clips database:', err);
    return false;
  }
}

function isDiscordConfigured() {
  return (
    DISCORD_CLIENT_ID &&
    DISCORD_CLIENT_SECRET &&
    DISCORD_CLIENT_ID !== 'your_client_id' &&
    DISCORD_CLIENT_SECRET !== 'your_client_secret'
  );
}

// Пользователь из сессии считается авторизованным, только если прошёл проверку участия в сервере.
// Старые сессии (до введения проверки) не содержат isMember и требуют повторного входа.
function sessionMember(req) {
  const u = req.session && req.session.user;
  return u && u.isMember === true ? u : null;
}

// Данные участника сервера из Discord (scope guilds.members.read): состоит ли он на сервере и какие у него роли
async function fetchGuildMember(accessToken) {
  const r = await fetch(`https://discord.com/api/v10/users/@me/guilds/${DISCORD_GUILD_ID}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (r.ok) {
    const member = await r.json();
    const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
    return { status: 'member', isAdmin: roles.includes(String(DISCORD_ADMIN_ROLE_ID)) };
  }
  if (r.status === 404) return { status: 'not_member' }; // пользователь не состоит на сервере
  if (r.status === 401) return { status: 'unauthorized' }; // токен отозван или истёк
  const body = await r.text();
  throw new Error(`Guild member check failed (${r.status}): ${body}`);
}

function dropSession(req) {
  delete req.session.user;
  delete req.session.auth;
}

// Текущий пользователь: участник сервера (и, возможно, админ). Раз в MEMBER_RECHECK_MS данные
// перепроверяются в Discord — так снятая роль или выход с сервера действуют почти сразу.
async function resolveUser(req) {
  const user = sessionMember(req);
  if (!user) return null;

  const auth = req.session.auth;
  if (user.isDev) return user; // демо-сессии без Discord не перепроверяем
  if (!auth) { dropSession(req); return null; } // сессия без токена — нужен повторный вход

  if (Date.now() - (auth.checkedAt || 0) < MEMBER_RECHECK_MS) return user;

  if (Date.now() >= auth.expiresAt) { // токен истёк, проверить нельзя
    dropSession(req);
    return null;
  }

  try {
    const m = await fetchGuildMember(auth.accessToken);
    if (m.status !== 'member') {
      dropSession(req); // вышел с сервера или отозвал доступ
      return null;
    }
    user.isAdmin = m.isAdmin;
    auth.checkedAt = Date.now();
  } catch (err) {
    // Discord временно недоступен — оставляем текущие права и пробуем снова через минуту
    console.warn('Membership re-check failed:', err.message);
    auth.checkedAt = Date.now() - MEMBER_RECHECK_MS + 60 * 1000;
  }
  return user;
}

function canManageClip(user, clip) {
  return Boolean(user && (user.isAdmin || (clip.author && clip.author.id === user.id)));
}

// Длительность видео через ffmpeg (читаем "Duration:" из stderr), без зависимости от ffprobe
function probeDuration(file) {
  return new Promise((resolve) => {
    try {
      const p = spawn(ffmpegBin, ['-hide_banner', '-i', file]);
      let err = '';
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('error', () => resolve(null));
      p.on('close', () => {
        const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        if (!m) return resolve(null);
        const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
        resolve(Number.isFinite(sec) ? Math.round(sec * 10) / 10 : null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function resolveUploadPath(url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/')) return null;
  try {
    const rel = decodeURIComponent(url.slice('/uploads/'.length).split('?')[0]);
    const base = path.resolve(UPLOADS_DIR);
    const abs = path.resolve(base, rel);
    return abs.startsWith(base + path.sep) ? abs : null;
  } catch (e) {
    return null;
  }
}

// Все файлы, принадлежащие клипу (видео во всех качествах + превью)
function clipFilePaths(clip) {
  const set = new Set();
  const add = (p) => { if (p) set.add(p); };
  if (/^[\w-]+$/.test(String(clip.id))) {
    ['1080p', '720p', '480p', '360p'].forEach((q) => add(path.join(VIDEOS_DIR, `${clip.id}_${q}.mp4`)));
    add(path.join(VIDEOS_DIR, `${clip.id}.mp4`));
    add(path.join(THUMBNAILS_DIR, `${clip.id}.jpg`));
  }
  add(resolveUploadPath(clip.videoUrl));
  add(resolveUploadPath(clip.thumbnailUrl));
  Object.values(clip.qualities || {}).forEach((u) => add(resolveUploadPath(u)));
  return [...set];
}

function deleteClipFiles(clip, otherClips) {
  // Не трогаем файлы, на которые ссылается другой клип
  const keep = new Set();
  otherClips.forEach((c) => clipFilePaths(c).forEach((p) => keep.add(p)));
  clipFilePaths(clip).forEach((p) => {
    if (keep.has(p)) return;
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { console.warn('Could not delete', p, e.message); }
  });
}

function findClipVideoFile(clip) {
  const candidates = [
    resolveUploadPath(clip.videoUrl),
    path.join(VIDEOS_DIR, `${clip.id}_720p.mp4`),
    path.join(VIDEOS_DIR, `${clip.id}_1080p.mp4`),
    path.join(VIDEOS_DIR, `${clip.id}_480p.mp4`),
    path.join(VIDEOS_DIR, `${clip.id}_360p.mp4`),
    path.join(VIDEOS_DIR, `${clip.id}.mp4`)
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// Фоновое определение длительности для старых клипов (нужна для сортировки в галерее)
async function backfillDurations() {
  const pending = getClips().filter((c) => c.duration == null).map((c) => c.id);
  for (const id of pending) {
    const clip = getClips().find((c) => c.id === id);
    if (!clip) continue;
    const file = findClipVideoFile(clip);
    let duration = 0; // файла нет — больше не пытаемся
    if (file) {
      duration = await probeDuration(file);
      if (duration == null) continue; // временная ошибка — попробуем при следующем запуске
    }
    // Читаем и сохраняем синхронно, чтобы не потерять параллельные изменения
    const clips = getClips();
    const target = clips.find((c) => c.id === id);
    if (target) {
      target.duration = duration;
      saveClips(clips);
    }
  }
}

function commentWithinEditWindow(comment) {
  const created = Date.parse(comment.createdAt);
  return Number.isFinite(created) && Date.now() - created <= COMMENT_EDIT_WINDOW_MS;
}

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: false, // set to true if HTTPS behind proxy
      httpOnly: true
    }
  })
);

// req.user — только участник сервера, прошедший проверку (иначе undefined/null)
app.use(async (req, res, next) => {
  try {
    // Перепроверку в Discord делаем только для запросов к API (не для видео и картинок)
    req.user = req.path.startsWith('/api/') ? await resolveUser(req) : sessionMember(req);
  } catch (err) {
    console.error('resolveUser error:', err);
    req.user = null;
  }
  next();
});

// Serve uploaded video files (H.264 MP4 with Range headers for seeking)
app.use('/uploads/videos', express.static(VIDEOS_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// Serve uploaded thumbnail images
app.use('/uploads/thumbnails', express.static(THUMBNAILS_DIR));

// Backward compatibility: serve root /uploads and fallback to videos/thumbnails if needed
app.use('/uploads', express.static(UPLOADS_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mp4')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
    }
  }
}));

// Route fallback for legacy direct URLs /uploads/:filename
app.get('/uploads/:filename', (req, res, next) => {
  const filename = req.params.filename;
  if (filename.endsWith('.mp4')) {
    const videoPath = path.join(VIDEOS_DIR, filename);
    if (fs.existsSync(videoPath)) return res.sendFile(videoPath);
    // Also check if :id_720p.mp4 exists
    const p720 = path.join(VIDEOS_DIR, filename.replace('.mp4', '_720p.mp4'));
    if (fs.existsSync(p720)) return res.sendFile(p720);
  } else if (filename.endsWith('.jpg') || filename.endsWith('.png')) {
    const thumbPath = path.join(THUMBNAILS_DIR, filename);
    if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);
  }
  next();
});

// Serve static frontend assets
app.use(express.static(path.join(__dirname, 'public')));

// Multer setup for temporary uploads (storing strictly in dedicated temp/ folder)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `upload_${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 250 * 1024 * 1024 // 250MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Разрешены только видеофайлы (MP4, WebM, MOV, MKV)!'));
    }
  }
});

// Authentication middleware
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Требуется вход через Discord и членство на сервере сообщества' });
  }
  next();
}

// -------------------------------------------------------------
// Discord OAuth2 Routes
// -------------------------------------------------------------

app.get('/auth/discord', (req, res) => {
  if (!isDiscordConfigured()) {
    // If Discord credentials are not set, allow dev mode login or inform user
    if (req.query.dev === '1') {
      req.session.user = {
        id: '133742069000000001',
        username: 'DiscordCommunityGamer',
        avatar: null,
        avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
        isMember: true,
        isDev: true
      };
      return res.redirect('/');
    }
    return res.redirect('/?error=discord_not_configured');
  }

  // guilds.members.read — чтобы проверить, что пользователь состоит на нашем сервере
  const scope = encodeURIComponent('identify guilds.members.read');
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(
    DISCORD_REDIRECT_URI
  )}&response_type=code&scope=${scope}`;
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?error=no_code_provided');
  }

  try {
    // Exchange authorization code for access token
    const tokenParams = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_REDIRECT_URI
    });

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: tokenParams.toString()
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Discord Token Error:', errText);
      return res.redirect('/?error=token_exchange_failed');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    // Fetch user profile from Discord
    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!userResponse.ok) {
      return res.redirect('/?error=fetch_user_failed');
    }

    const userData = await userResponse.json();

    // Determine avatar URL
    let avatarUrl;
    if (userData.avatar) {
      const isAnimated = userData.avatar.startsWith('a_');
      const ext = isAnimated ? 'gif' : 'png';
      avatarUrl = `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.${ext}?size=128`;
    } else {
      const defaultIndex = userData.discriminator && userData.discriminator !== '0'
        ? Number(userData.discriminator) % 5
        : Number(BigInt(userData.id) >> 22n) % 6;
      avatarUrl = `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
    }

    // Проверяем, что пользователь состоит на сервере сообщества
    let member;
    try {
      member = await fetchGuildMember(accessToken);
    } catch (memberErr) {
      console.error('Guild membership check error:', memberErr.message);
      return res.redirect('/?error=membership_check_failed');
    }

    if (member.status === 'not_member') {
      return res.redirect('/?error=not_member');
    }
    if (member.status !== 'member') {
      console.error('Guild membership check: unexpected status', member.status);
      return res.redirect('/?error=membership_check_failed');
    }

    req.session.user = {
      id: userData.id,
      username: userData.global_name || userData.username,
      rawUsername: userData.username,
      avatar: userData.avatar,
      avatarUrl,
      isMember: true,
      isAdmin: member.isAdmin
    };
    // Токен хранится только на сервере (в cookie попадает лишь id сессии) и нужен для перепроверки роли
    req.session.auth = {
      accessToken,
      expiresAt: Date.now() + (Number(tokenData.expires_in) || 604800) * 1000,
      checkedAt: Date.now()
    };

    res.redirect('/');
  } catch (error) {
    console.error('Auth Callback Error:', error);
    res.redirect('/?error=auth_internal_error');
  }
});

// Dev-login route for testing without Discord Bot credentials
app.get('/auth/dev-login', (req, res) => {
  // Демо-вход работает только пока Discord не настроен. Иначе это обход проверки участия в сервере.
  if (isDiscordConfigured()) {
    return res.status(404).send('Not found');
  }
  const username = String(req.query.name || 'CommunityMember').slice(0, 32);
  const avatarIndex = Math.floor(Math.random() * 5);
  req.session.user = {
    id: `dev_${Date.now()}`,
    username: username,
    avatar: null,
    avatarUrl: `https://cdn.discordapp.com/embed/avatars/${avatarIndex}.png`,
    isMember: true,
    isAdmin: req.query.admin === '1', // для проверки админских функций: /auth/dev-login?admin=1
    isDev: true
  };
  res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/api/me', (req, res) => {
  const stale = Boolean(req.session && req.session.user && !req.user);
  res.json({
    user: req.user || null,
    needsRelogin: stale, // сессия без проверки участия — нужно войти заново
    isDiscordConfigured: isDiscordConfigured()
  });
});

// -------------------------------------------------------------
// Video Processing & Upload Endpoint
// -------------------------------------------------------------

function processVideoQualities(inputPath, clipId, trimOptions = {}) {
  return new Promise((resolve, reject) => {
    const out1080 = path.join(VIDEOS_DIR, `${clipId}_1080p.mp4`);
    const out720 = path.join(VIDEOS_DIR, `${clipId}_720p.mp4`);
    const out480 = path.join(VIDEOS_DIR, `${clipId}_480p.mp4`);
    const out360 = path.join(VIDEOS_DIR, `${clipId}_360p.mp4`);
    const thumbPath = path.join(THUMBNAILS_DIR, `${clipId}.jpg`);

    // Optional video trimming arguments (-ss and -t)
    const trimArgs = [];
    const trimStart = parseFloat(trimOptions.trimStart) || 0;
    const trimEnd = parseFloat(trimOptions.trimEnd) || 0;

    if (trimStart > 0) {
      trimArgs.push('-ss', String(trimStart));
    }
    if (trimEnd > trimStart) {
      trimArgs.push('-t', String(trimEnd - trimStart));
    }

    // Multi-quality transcode with high visual fidelity (CRF encoding, no heavy compression artifacts)
    const args = [
      ...trimArgs,
      '-i', inputPath,
      '-filter_complex', '[0:v]split=4[v1080][v720][v480][v360];' +
                         '[v1080]scale=-2:1080[out1080];' +
                         '[v720]scale=-2:720[out720];' +
                         '[v480]scale=-2:480,fps=30[out480];' +
                         '[v360]scale=-2:360,fps=30[out360]',
      '-map', '[out1080]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '19', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-y', out1080,
      '-map', '[out720]',  '-map', '0:a?', '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-y', out720,
      '-map', '[out480]',  '-map', '0:a?', '-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '96k',  '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-y', out480,
      '-map', '[out360]',  '-map', '0:a?', '-c:v', 'libx264', '-crf', '25', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '64k',  '-movflags', '+faststart', '-pix_fmt', 'yuv420p', '-y', out360
    ];

    const proc = spawn(ffmpegBin, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`FFmpeg transcode error (code ${code}):`, stderr);
        return reject(new Error(`FFmpeg exited with code ${code}`));
      }

      // Generate thumbnail screenshot from 720p output at 1 second (or 0s)
      const thumbArgs = ['-ss', '00:00:01', '-i', out720, '-vframes', '1', '-q:v', '2', '-y', thumbPath];
      const thumbProc = spawn(ffmpegBin, thumbArgs);
      thumbProc.on('close', () => {
        const finalize = async () => {
          const duration = await probeDuration(out720);
          resolve({
            duration,
            qualities: {
              '1080p': `/uploads/videos/${clipId}_1080p.mp4`,
              '720p': `/uploads/videos/${clipId}_720p.mp4`,
              '480p': `/uploads/videos/${clipId}_480p.mp4`,
              '360p': `/uploads/videos/${clipId}_360p.mp4`
            },
            videoUrl: `/uploads/videos/${clipId}_720p.mp4`,
            thumbnailUrl: fs.existsSync(thumbPath) ? `/uploads/thumbnails/${clipId}.jpg` : null
          });
        };

        if (!fs.existsSync(thumbPath)) {
          // Fallback to timestamp 0s if clip is shorter than 1s
          const thumbProc0 = spawn(ffmpegBin, ['-ss', '00:00:00', '-i', out720, '-vframes', '1', '-q:v', '2', '-y', thumbPath]);
          thumbProc0.on('close', finalize);
        } else {
          finalize();
        }
      });
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function sendDiscordWebhook(clip, author, req) {
  if (!DISCORD_WEBHOOK_URL || DISCORD_WEBHOOK_URL.includes('xxx/yyy')) {
    return;
  }

  try {
    const origin = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const clipUrl = `${origin}/clip/${clip.id}`;
    const authorMention = /^\d+$/.test(author.id) ? `<@${author.id}>` : `@${author.username}`;

    // Target webhook URL must include ?with_components=true so Discord renders Message Components (Buttons)
    let webhookEndpoint = DISCORD_WEBHOOK_URL;
    if (!webhookEndpoint.includes('with_components=')) {
      webhookEndpoint += (webhookEndpoint.includes('?') ? '&' : '?') + 'with_components=true';
    }

    // Discord Embed formatted for the platform
    const embed = {
      author: {
        name: `${BRAND_NAME} - Record what just happened with the press of a button`
      },
      description: `**${author.username}**`,
      title: `${clip.title} - Clipped ${clip.game || 'Game'} with ${BRAND_NAME}`,
      url: clipUrl,
      color: 0x111217
    };

    // Component Link Button: [ ❤️ Like on ClipHub ]
    const components = [
      {
        type: 1, // Action row
        components: [
          {
            type: 2, // Button
            style: 5, // Link button
            label: `Like on ${BRAND_NAME}`,
            emoji: { name: '❤️' },
            url: clipUrl
          }
        ]
      }
    ];

    const content = `${authorMention} shared a clip\n\n[View on ${BRAND_NAME}](${clipUrl})`;

    const thumbFilename = `${clip.id}.jpg`;
    const localThumbPath = path.join(THUMBNAILS_DIR, thumbFilename);

    // If local thumbnail file exists, attach it as multipart file so Discord hosts & displays it reliably
    if (fs.existsSync(localThumbPath)) {
      embed.image = { url: 'attachment://thumbnail.jpg' };

      // Notice: Do NOT pass username or avatar_url so webhook retains Discord configured identity
      const payload = {
        content,
        embeds: [embed],
        components
      };

      const formData = new FormData();
      formData.append('payload_json', JSON.stringify(payload));
      const fileBytes = fs.readFileSync(localThumbPath);
      formData.append('files[0]', new Blob([fileBytes], { type: 'image/jpeg' }), 'thumbnail.jpg');

      const response = await fetch(webhookEndpoint, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn('Discord webhook failed with components, retrying:', errText);
      }
    } else {
      if (clip.thumbnailUrl && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
        embed.image = { url: `${origin}${clip.thumbnailUrl}` };
      }

      const payload = {
        content,
        embeds: [embed],
        components
      };

      await fetch(webhookEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
  } catch (err) {
    console.error('Failed to dispatch Discord webhook:', err);
  }
}

app.post('/api/upload', requireAuth, upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Видеофайл не был загружен' });
  }

  const rawPath = req.file.path;
  const clipId = crypto.randomBytes(4).toString('hex'); // 8-char unique ID
  const title = (req.body.title || path.parse(req.file.originalname).name || 'Новый клип').trim().slice(0, 100);
  const game = (req.body.game || 'Другое').trim().slice(0, 50);

  // Optional trimming during upload
  const trimStart = parseFloat(req.body.trimStart) || 0;
  const trimEnd = parseFloat(req.body.trimEnd) || 0;
  const trimOptions = (trimStart > 0 || trimEnd > trimStart) ? { trimStart, trimEnd } : {};

  try {
    let processedResult;
    try {
      processedResult = await processVideoQualities(rawPath, clipId, trimOptions);
    } catch (ffmpegErr) {
      console.warn('FFmpeg multi-quality compression failed, fallback to original:', ffmpegErr.message);
      const fallbackVideoName = `${clipId}_720p.mp4`;
      const fallbackVideoPath = path.join(VIDEOS_DIR, fallbackVideoName);
      fs.copyFileSync(rawPath, fallbackVideoPath);
      processedResult = {
        qualities: {
          '720p': `/uploads/videos/${fallbackVideoName}`
        },
        videoUrl: `/uploads/videos/${fallbackVideoName}`,
        thumbnailUrl: null,
        duration: await probeDuration(fallbackVideoPath)
      };
    } finally {
      // Always delete temporary raw upload file from temp/
      if (fs.existsSync(rawPath)) {
        try { fs.unlinkSync(rawPath); } catch (e) {}
      }
    }

    // Save clip to DB
    const clips = getClips();
    const newClip = {
      id: clipId,
      title,
      game,
      videoUrl: processedResult.videoUrl,
      thumbnailUrl: processedResult.thumbnailUrl,
      qualities: processedResult.qualities,
      duration: processedResult.duration || null,
      originalFilename: req.file.originalname,
      createdAt: new Date().toISOString(),
      views: 0,
      author: {
        id: req.user.id,
        username: req.user.username,
        avatarUrl: req.user.avatarUrl
      },
      likes: [],
      dislikes: [],
      comments: []
    };

    clips.unshift(newClip);
    saveClips(clips);

    // Send Discord Webhook notification
    sendDiscordWebhook(newClip, req.user, req);

    res.json({
      success: true,
      id: clipId,
      url: `/clip/${clipId}`,
      clip: newClip
    });
  } catch (error) {
    console.error('Upload Error:', error);
    if (fs.existsSync(rawPath)) {
      try { fs.unlinkSync(rawPath); } catch (e) {}
    }
    res.status(500).json({ error: 'Ошибка при сохранении и обработке клипа' });
  }
});

// -------------------------------------------------------------
// Clip Detail, Reactions, and Comments Endpoints
// -------------------------------------------------------------

// Gallery page (данные отдаёт /api/gallery — только для участников сервера)
app.get('/gallery', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

// Serve watch page
app.get('/clip/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'watch.html'));
});

// Get clip details (with view increment)
app.get('/api/clips/:id', (req, res) => {
  const clips = getClips();
  const clip = clips.find((c) => c.id === req.params.id);

  if (!clip) {
    return res.status(404).json({ error: 'Клип не найден' });
  }

  // Increment views
  clip.views = (clip.views || 0) + 1;
  saveClips(clips);

  // Determine current user reaction
  const userId = req.user ? req.user.id : null;
  let userReaction = null;
  if (userId) {
    if (clip.likes && clip.likes.includes(userId)) {
      userReaction = 'like';
    } else if (clip.dislikes && clip.dislikes.includes(userId)) {
      userReaction = 'dislike';
    }
  }

  // Ensure qualities structure is present (with graceful fallback if legacy)
  const qualities = clip.qualities || {
    '1080p': clip.videoUrl,
    '720p': clip.videoUrl,
    '480p': clip.videoUrl,
    '360p': clip.videoUrl
  };

  res.json({
    id: clip.id,
    title: clip.title,
    game: clip.game,
    videoUrl: clip.videoUrl,
    thumbnailUrl: clip.thumbnailUrl,
    qualities,
    author: clip.author,
    createdAt: clip.createdAt,
    views: clip.views,
    likesCount: (clip.likes || []).length,
    dislikesCount: (clip.dislikes || []).length,
    userReaction,
    isOwner: Boolean(req.user && clip.author && clip.author.id === req.user.id),
    canManage: canManageClip(req.user, clip),
    duration: clip.duration || null,
    commentEditWindowMs: COMMENT_EDIT_WINDOW_MS,
    comments: clip.comments || []
  });
});

// Reactions endpoint
app.post('/api/clips/:id/react', requireAuth, (req, res) => {
  const { type } = req.body; // 'like' or 'dislike'
  if (!['like', 'dislike'].includes(type)) {
    return res.status(400).json({ error: 'Неверный тип реакции' });
  }

  const clips = getClips();
  const clip = clips.find((c) => c.id === req.params.id);
  if (!clip) {
    return res.status(404).json({ error: 'Клип не найден' });
  }

  clip.likes = clip.likes || [];
  clip.dislikes = clip.dislikes || [];
  const userId = req.user.id;

  let currentReaction = null;

  if (type === 'like') {
    if (clip.likes.includes(userId)) {
      clip.likes = clip.likes.filter((id) => id !== userId);
    } else {
      clip.likes.push(userId);
      clip.dislikes = clip.dislikes.filter((id) => id !== userId);
      currentReaction = 'like';
    }
  } else if (type === 'dislike') {
    if (clip.dislikes.includes(userId)) {
      clip.dislikes = clip.dislikes.filter((id) => id !== userId);
    } else {
      clip.dislikes.push(userId);
      clip.likes = clip.likes.filter((id) => id !== userId);
      currentReaction = 'dislike';
    }
  }

  saveClips(clips);

  res.json({
    success: true,
    likesCount: clip.likes.length,
    dislikesCount: clip.dislikes.length,
    userReaction: currentReaction
  });
});

// Comments endpoint
app.post('/api/clips/:id/comment', requireAuth, (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text || text.length === 0) {
    return res.status(400).json({ error: 'Комментарий не может быть пустым' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Максимальная длина комментария — 500 символов' });
  }

  const clips = getClips();
  const clip = clips.find((c) => c.id === req.params.id);
  if (!clip) {
    return res.status(404).json({ error: 'Клип не найден' });
  }

  clip.comments = clip.comments || [];
  const comment = {
    id: crypto.randomBytes(4).toString('hex'),
    userId: req.user.id,
    username: req.user.username,
    avatarUrl: req.user.avatarUrl,
    text,
    createdAt: new Date().toISOString()
  };

  clip.comments.push(comment);
  saveClips(clips);

  res.json({
    success: true,
    comment
  });
});

// -------------------------------------------------------------
// Gallery (только для участников сервера) и управление своими клипами
// -------------------------------------------------------------

app.get('/api/games', (req, res) => {
  res.json({ games: GAME_OPTIONS });
});

const GALLERY_SORTS = {
  date: (c) => Date.parse(c.createdAt) || 0,
  views: (c) => c.views || 0,
  likes: (c) => (c.likes || []).length,
  dislikes: (c) => (c.dislikes || []).length,
  comments: (c) => (c.comments || []).length,
  duration: (c) => c.duration || 0,
  rating: (c) => (c.likes || []).length - (c.dislikes || []).length,
  title: (c) => String(c.title || '').toLowerCase()
};

app.get('/api/gallery', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  const game = String(req.query.game || '').trim();
  const mine = req.query.mine === '1';
  const sort = Object.prototype.hasOwnProperty.call(GALLERY_SORTS, req.query.sort) ? String(req.query.sort) : 'date';
  const dir = req.query.dir === 'asc' ? 1 : -1;
  const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 10000);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 24, 1), 60);

  let list = getClips();

  if (mine) {
    list = list.filter((c) => c.author && c.author.id === req.user.id);
  }
  if (q) {
    list = list.filter((c) =>
      String(c.title || '').toLowerCase().includes(q) ||
      String((c.author && c.author.username) || '').toLowerCase().includes(q) ||
      String(c.game || '').toLowerCase().includes(q)
    );
  }

  // Счётчики по играм (с учётом поиска и «мои», но до фильтра по игре)
  const gameCounts = new Map();
  list.forEach((c) => {
    const g = c.game || 'Другое';
    gameCounts.set(g, (gameCounts.get(g) || 0) + 1);
  });
  const games = [...gameCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru'));

  if (game) {
    list = list.filter((c) => (c.game || 'Другое') === game);
  }

  const key = GALLERY_SORTS[sort];
  const byDate = GALLERY_SORTS.date;
  list = list.slice().sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    const cmp = typeof ka === 'string' ? ka.localeCompare(kb, 'ru') : ka - kb;
    if (cmp !== 0) return cmp * dir;
    return byDate(b) - byDate(a); // при равенстве — более новые выше
  });

  const total = list.length;
  const items = list.slice((page - 1) * pageSize, page * pageSize).map((c) => ({
    id: c.id,
    title: c.title,
    game: c.game || 'Другое',
    thumbnailUrl: c.thumbnailUrl || null,
    duration: c.duration || null,
    views: c.views || 0,
    likes: (c.likes || []).length,
    dislikes: (c.dislikes || []).length,
    comments: (c.comments || []).length,
    createdAt: c.createdAt,
    author: c.author
      ? { id: c.author.id, username: c.author.username, avatarUrl: c.author.avatarUrl }
      : { id: null, username: 'Неизвестный автор', avatarUrl: null },
    isOwner: Boolean(c.author && c.author.id === req.user.id),
    canManage: canManageClip(req.user, c)
  }));

  res.json({ clips: items, total, page, pageSize, hasMore: page * pageSize < total, games });
});

// Изменить название и/или игру своего клипа
app.patch('/api/clips/:id', requireAuth, (req, res) => {
  const clips = getClips();
  const clip = clips.find((c) => c.id === req.params.id);
  if (!clip) {
    return res.status(404).json({ error: 'Клип не найден' });
  }
  if (!canManageClip(req.user, clip)) {
    return res.status(403).json({ error: 'Изменять можно только свои клипы' });
  }

  const body = req.body || {};
  if (body.title === undefined && body.game === undefined) {
    return res.status(400).json({ error: 'Нечего изменять' });
  }

  if (body.title !== undefined) {
    const title = String(body.title).trim().slice(0, 100);
    if (!title) {
      return res.status(400).json({ error: 'Название не может быть пустым' });
    }
    clip.title = title;
  }
  if (body.game !== undefined) {
    clip.game = String(body.game).trim().slice(0, 50) || 'Другое';
  }

  saveClips(clips);
  res.json({ success: true, title: clip.title, game: clip.game });
});

// Удалить свой клип (вместе с файлами видео и превью)
app.delete('/api/clips/:id', requireAuth, (req, res) => {
  const clips = getClips();
  const index = clips.findIndex((c) => c.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Клип не найден' });
  }
  const clip = clips[index];
  if (!canManageClip(req.user, clip)) {
    return res.status(403).json({ error: 'Удалять можно только свои клипы' });
  }

  clips.splice(index, 1);
  saveClips(clips);
  deleteClipFiles(clip, clips);

  res.json({ success: true });
});

// Изменить свой комментарий (только в течение 24 часов после публикации)
app.patch('/api/clips/:id/comments/:commentId', requireAuth, (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Комментарий не может быть пустым' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Максимальная длина комментария — 500 символов' });
  }

  const clips = getClips();
  const clip = clips.find((c) => c.id === req.params.id);
  if (!clip) {
    return res.status(404).json({ error: 'Клип не найден' });
  }
  const comment = (clip.comments || []).find((c) => c.id === req.params.commentId);
  if (!comment) {
    return res.status(404).json({ error: 'Комментарий не найден' });
  }
  if (comment.userId !== req.user.id) {
    return res.status(403).json({ error: 'Изменять можно только свои комментарии' });
  }
  if (!commentWithinEditWindow(comment)) {
    return res.status(403).json({ error: 'Изменить комментарий можно только в течение 24 часов после публикации' });
  }

  comment.text = text;
  comment.editedAt = new Date().toISOString();
  saveClips(clips);

  res.json({ success: true, comment });
});

// Удалить свой комментарий (только в течение 24 часов после публикации)
app.delete('/api/clips/:id/comments/:commentId', requireAuth, (req, res) => {
  const clips = getClips();
  const clip = clips.find((c) => c.id === req.params.id);
  if (!clip) {
    return res.status(404).json({ error: 'Клип не найден' });
  }
  const comments = clip.comments || [];
  const index = comments.findIndex((c) => c.id === req.params.commentId);
  if (index === -1) {
    return res.status(404).json({ error: 'Комментарий не найден' });
  }
  const comment = comments[index];
  // Админ может удалить любой комментарий в любое время; остальные — только свои в течение 24 часов
  if (!req.user.isAdmin) {
    if (comment.userId !== req.user.id) {
      return res.status(403).json({ error: 'Удалять можно только свои комментарии' });
    }
    if (!commentWithinEditWindow(comment)) {
      return res.status(403).json({ error: 'Удалить комментарий можно только в течение 24 часов после публикации' });
    }
  }

  comments.splice(index, 1);
  saveClips(clips);

  res.json({ success: true });
});

// Trim existing clip endpoint
app.post('/api/clips/:id/trim', requireAuth, async (req, res) => {
  const { startTime, endTime, mode, newTitle } = req.body;
  const trimStart = parseFloat(startTime) || 0;
  const trimEnd = parseFloat(endTime) || 0;

  if (trimEnd <= trimStart) {
    return res.status(400).json({ error: 'Время окончания должно быть больше времени начала' });
  }

  const clips = getClips();
  const clip = clips.find((c) => c.id === req.params.id);
  if (!clip) {
    return res.status(404).json({ error: 'Клип не найден' });
  }

  // Find best source video file (prefer 1080p, fallback to 720p or original)
  let sourcePath = path.join(VIDEOS_DIR, `${clip.id}_1080p.mp4`);
  if (!fs.existsSync(sourcePath)) {
    sourcePath = path.join(VIDEOS_DIR, `${clip.id}_720p.mp4`);
  }
  if (!fs.existsSync(sourcePath)) {
    sourcePath = path.join(VIDEOS_DIR, `${clip.id}.mp4`);
  }
  if (!fs.existsSync(sourcePath)) {
    return res.status(404).json({ error: 'Исходный видеофайл клипа не найден на диске' });
  }

  const isNew = mode === 'new';

  // Заменить исходный клип может только его автор (копию-отрезок может сделать любой участник)
  if (!isNew && (!clip.author || clip.author.id !== req.user.id)) {
    return res.status(403).json({ error: 'Заменять можно только свои клипы' });
  }

  const targetClipId = isNew ? crypto.randomBytes(4).toString('hex') : clip.id;

  try {
    const processed = await processVideoQualities(sourcePath, targetClipId, {
      trimStart,
      trimEnd
    });

    // Читаем базу заново: пока шла обработка, мог измениться счётчик просмотров, лайки и т.д.
    const freshClips = getClips();

    if (isNew) {
      const newClip = {
        id: targetClipId,
        title: (newTitle || `${clip.title} (Отрезок)`).trim().slice(0, 100),
        game: clip.game,
        videoUrl: processed.videoUrl,
        thumbnailUrl: processed.thumbnailUrl,
        qualities: processed.qualities,
        duration: processed.duration || null,
        originalFilename: `trimmed_${clip.originalFilename || 'clip.mp4'}`,
        createdAt: new Date().toISOString(),
        views: 0,
        author: {
          id: req.user.id,
          username: req.user.username,
          avatarUrl: req.user.avatarUrl
        },
        likes: [],
        dislikes: [],
        comments: []
      };

      freshClips.unshift(newClip);
      saveClips(freshClips);
      sendDiscordWebhook(newClip, req.user, req);

      return res.json({
        success: true,
        mode: 'new',
        clipId: targetClipId,
        url: `/clip/${targetClipId}`
      });
    } else {
      const target = freshClips.find((c) => c.id === clip.id);
      if (!target) {
        return res.status(404).json({ error: 'Клип был удалён во время обработки' });
      }
      target.videoUrl = processed.videoUrl;
      target.thumbnailUrl = processed.thumbnailUrl;
      target.qualities = processed.qualities;
      target.duration = processed.duration || target.duration || null;
      saveClips(freshClips);

      return res.json({
        success: true,
        mode: 'replace',
        clipId: clip.id,
        url: `/clip/${clip.id}`
      });
    }
  } catch (err) {
    console.error('Trim error:', err);
    return res.status(500).json({ error: 'Ошибка при обрезке клипа: ' + err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 Discord ClipHub server running on port ${PORT}`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`🔑 Discord OAuth: ${isDiscordConfigured() ? 'CONFIGURED ✅' : 'NOT CONFIGURED (Dev Login Available) ⚠️'}`);
  console.log(`🛡️  Доступ только для участников сервера: ${DISCORD_GUILD_ID}`);
  console.log(`👑 Роль администратора: ${DISCORD_ADMIN_ROLE_ID}`);
  console.log(`===============================================`);

  backfillDurations().catch((err) => console.error('Duration backfill failed:', err));
});
