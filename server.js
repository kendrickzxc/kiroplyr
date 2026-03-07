// =========================================================
// KiroPlayr server.js — reworked
// =========================================================
const express  = require("express");
const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const cors     = require("cors");
const axios    = require("axios");
const path     = require("path");
const http     = require("http");
const https    = require("https");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Config ─────────────────────────────────────────────────────
const MONGO_URI  = "mongodb+srv://ryoevisu:XaneKath1@cluster0.5hy2uez.mongodb.net/kiroplayr?appName=Cluster0";
const JWT_SECRET = "kiroplayr_secret_key_2024";
const PORT       = process.env.PORT || 3000;

// Keep-alive agents for faster repeated connections to archive.org
const httpAgent  = new http.Agent ({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

// ── MongoDB ────────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(() => console.log("[DB] Connected"));

const Admin  = mongoose.model("Admin",  new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
}));

const Folder = mongoose.model("Folder", new mongoose.Schema(
  { name: String },
  { timestamps: true }
));

// Video stores the raw MP4 url as saved — proxy wraps it on the fly
const Video  = mongoose.model("Video",  new mongoose.Schema(
  {
    folderId: mongoose.Schema.Types.ObjectId,
    title:    String,
    url:      String,   // raw MP4 link e.g. https://ia800409.us.archive.org/21/items/...mp4
  },
  { timestamps: true }
));

// Seed default admin
(async () => {
  if (!await Admin.findOne({ username: "kiro" })) {
    await Admin.create({ username: "kiro", password: await bcrypt.hash("XaneKath1", 10) });
    console.log("[Auth] Admin seeded");
  }
})();

// ── Auth middleware ─────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.admin = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── Build response links for a video ───────────────────────────
// directUrl → proxy of the raw MP4 (CORS-free, streamable anywhere)
// embedUrl  → /embed?v=<raw-mp4-url>
//   e.g. https://kiroplyr.onrender.com/embed?v=https://ia800409.us.archive.org/...mp4
function buildLinks(host, video) {
  const base = `https://${host}`;
  return {
    directUrl: `${base}/api/proxy?url=${encodeURIComponent(video.url)}`,
    embedUrl:  `${base}/embed?v=${encodeURIComponent(video.url)}`,
  };
}

function withLinks(req, video) {
  return { ...video.toObject(), ...buildLinks(req.get("host"), video) };
}

// ── Auth ────────────────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await Admin.findOne({ username });
    if (!admin || !(await bcrypt.compare(password, admin.password)))
      return res.status(401).json({ error: "Invalid credentials" });
    const token = jwt.sign(
      { sub: admin._id, username: admin.username },
      JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({ token, username: admin.username, role: "admin" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Folders ─────────────────────────────────────────────────────
app.get("/api/folders", auth, async (req, res) => {
  const folders = await Folder.find().sort({ createdAt: -1 });
  res.json({ data: folders });
});

app.post("/api/folders", auth, async (req, res) => {
  const folder = await Folder.create({ name: req.body.name });
  res.status(201).json({ data: folder });
});

app.patch("/api/folders/:id", auth, async (req, res) => {
  const folder = await Folder.findByIdAndUpdate(
    req.params.id, { name: req.body.name }, { new: true }
  );
  res.json({ data: folder });
});

app.delete("/api/folders/:id", auth, async (req, res) => {
  await Folder.findByIdAndDelete(req.params.id);
  await Video.deleteMany({ folderId: req.params.id }); // cascade delete videos
  res.json({ data: { success: true } });
});

// ── Videos ──────────────────────────────────────────────────────
app.get("/api/videos/folder/:folderId", auth, async (req, res) => {
  const videos = await Video.find({ folderId: req.params.folderId }).sort({ createdAt: -1 });
  res.json({ data: videos.map(v => withLinks(req, v)) });
});

// Public — embed.html calls this to get the video URL
app.get("/api/videos/:id", async (req, res) => {
  try {
    const video = await Video.findById(req.params.id);
    if (!video) return res.status(404).json({ error: "Video not found" });
    res.json({ data: withLinks(req, video) });
  } catch {
    res.status(400).json({ error: "Invalid video ID" });
  }
});

app.post("/api/videos", auth, async (req, res) => {
  const { folderId, title, url } = req.body;
  if (!folderId || !title || !url)
    return res.status(400).json({ error: "folderId, title, and url are required" });
  const video = await Video.create({ folderId, title, url });
  res.status(201).json({ data: withLinks(req, video) });
});

app.patch("/api/videos/:id", auth, async (req, res) => {
  const video = await Video.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!video) return res.status(404).json({ error: "Video not found" });
  res.json({ data: withLinks(req, video) });
});

app.delete("/api/videos/:id", auth, async (req, res) => {
  await Video.findByIdAndDelete(req.params.id);
  res.json({ data: { success: true } });
});

// ── Proxy — CORS bypass for archive.org (and any MP4 host) ─────
//
// Supports:
//   GET  /api/proxy?url=<encoded-mp4-url>   — stream video
//   HEAD /api/proxy?url=<encoded-mp4-url>   — metadata / duration check
//
// Range requests (seeking) are forwarded correctly so Vidstack
// can scrub to any position without re-downloading from the start.

function proxyHandler(req, res) {
  const raw = req.query.url;
  if (!raw) return res.status(400).json({ error: "Missing ?url param" });

  let target;
  try {
    target = decodeURIComponent(raw);
  } catch {
    return res.status(400).json({ error: "Malformed URL encoding" });
  }

  if (!/^https?:\/\//i.test(target))
    return res.status(400).json({ error: "Only http/https URLs allowed" });

  const isHead  = req.method === "HEAD";
  const range   = req.headers["range"];

  const upHeaders = {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept":          "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "identity",      // raw bytes — no gzip compression in stream
    "Referer":         "https://archive.org/",
    "Origin":          "https://archive.org",
    "Connection":      "keep-alive",
  };
  if (range) upHeaders["Range"] = range;

  // Set CORS + caching headers before we even hit upstream
  res.setHeader("Access-Control-Allow-Origin",   "*");
  res.setHeader("Access-Control-Allow-Headers",  "*");
  res.setHeader("Access-Control-Allow-Methods",  "GET, HEAD, OPTIONS");
  res.setHeader("Cross-Origin-Resource-Policy",  "cross-origin");
  res.setHeader("Cross-Origin-Embedder-Policy",  "unsafe-none");
  res.setHeader("Accept-Ranges",                 "bytes");
  // Let browsers & CDN cache proxy responses for 1 hour
  res.setHeader("Cache-Control",                 "public, max-age=3600");

  axios({
    method:       isHead ? "head" : "get",
    url:          target,
    responseType: "stream",
    headers:      upHeaders,
    timeout:      90_000,          // 90s — archive.org can be slow on first byte
    maxRedirects: 10,
    httpAgent,
    httpsAgent,
    decompress:   false,
  })
  .then(upstream => {
    // Mirror relevant headers from upstream
    const forward = [
      "content-type",
      "content-length",
      "content-range",
      "last-modified",
      "etag",
    ];
    forward.forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    // 206 Partial Content for range requests, otherwise use upstream status
    const status = range
      ? 206
      : upstream.status >= 200 && upstream.status < 300
        ? 200
        : upstream.status;

    res.status(status);

    if (isHead) return res.end();

    // Destroy upstream if client disconnects (saves bandwidth)
    req.on("close", () => upstream.data?.destroy?.());

    upstream.data.pipe(res);
  })
  .catch(e => {
    const status = e.response?.status || 502;
    const msg    = e.code === "ECONNABORTED"
      ? "Upstream timed out"
      : e.response?.statusText || e.message || "Proxy fetch failed";
    console.error("[proxy]", status, msg, "→", target);
    if (!res.headersSent) res.status(status).json({ error: msg });
  });
}

app.get    ("/api/proxy", proxyHandler);
app.head   ("/api/proxy", proxyHandler);
app.options("/api/proxy", (_, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.sendStatus(204);
});

// ── /embed — serve embed.html, video URL is in ?v= query param ──
// e.g. GET /embed?v=https://ia800409.us.archive.org/.../video.mp4
app.get("/embed", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "embed.html"));
});

// ── SPA fallback ────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`[KiroPlayr] Running on port ${PORT}`));
