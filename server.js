// =========================================================
// KiroPlayr server.js
// =========================================================
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const axios = require("axios");
const path = require("path");
const http = require("http");
const https = require("https");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

// ── Serve static files (signin.html, index.html, embed.html) ──
app.use(express.static(path.join(__dirname, "public")));

const MONGO_URI =
  "mongodb+srv://ryoevisu:XaneKath1@cluster0.5hy2uez.mongodb.net/kiroplayr?appName=Cluster0";
const JWT_SECRET = "kiroplayr_secret_key_2024";
const PORT = process.env.PORT || 3000;

// ── Reusable HTTP agents (keep-alive = faster repeat requests) ──
const httpAgent  = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

// ── DB ────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(() => console.log("[DB] Connected"));

const AdminSchema = new mongoose.Schema({ username: { type: String, unique: true }, password: String });
const FolderSchema = new mongoose.Schema({ name: String }, { timestamps: true });
const VideoSchema = new mongoose.Schema(
  { folderId: mongoose.Schema.Types.ObjectId, title: String, url: String },
  { timestamps: true }
);
const Admin  = mongoose.model("Admin",  AdminSchema);
const Folder = mongoose.model("Folder", FolderSchema);
const Video  = mongoose.model("Video",  VideoSchema);

// Seed admin
async function seedAdmin() {
  const exists = await Admin.findOne({ username: "kiro" });
  if (!exists) {
    await Admin.create({ username: "kiro", password: await bcrypt.hash("XaneKath1", 10) });
    console.log("[Auth] Admin seeded");
  }
}
seedAdmin();

// ── Auth middleware ───────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.admin = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── Auth routes ───────────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  const admin = await Admin.findOne({ username });
  if (!admin || !(await bcrypt.compare(password, admin.password)))
    return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ sub: admin._id, username: admin.username }, JWT_SECRET, { expiresIn: "7d" });
  // Flat response — token/username at root level
  res.json({ token, username: admin.username, role: "admin" });
});

// ── Folder routes ─────────────────────────────────────────────
app.get("/api/folders", authMiddleware, async (req, res) => {
  const folders = await Folder.find().sort({ createdAt: -1 });
  res.json({ data: folders });
});
app.post("/api/folders", authMiddleware, async (req, res) => {
  const folder = await Folder.create({ name: req.body.name });
  res.status(201).json({ data: folder });
});
app.patch("/api/folders/:id", authMiddleware, async (req, res) => {
  const folder = await Folder.findByIdAndUpdate(req.params.id, { name: req.body.name }, { new: true });
  res.json({ data: folder });
});
app.delete("/api/folders/:id", authMiddleware, async (req, res) => {
  await Folder.findByIdAndDelete(req.params.id);
  await Video.deleteMany({ folderId: req.params.id }); // cascade
  res.json({ data: { success: true } });
});

// ── Video helpers ─────────────────────────────────────────────
function makeLinks(req, id) {
  const base = req.protocol + "://" + req.get("host");
  return {
    directUrl: `${base}/api/proxy?url=${encodeURIComponent(base + "/api/videos/" + id)}`,
    embedUrl:  `${base}/embed.html?id=${id}`,
  };
}

// ── Video routes ──────────────────────────────────────────────
app.get("/api/videos/folder/:folderId", authMiddleware, async (req, res) => {
  const videos = await Video.find({ folderId: req.params.folderId }).sort({ createdAt: -1 });
  res.json({ data: videos.map((v) => ({ ...v.toObject(), ...makeLinks(req, v._id) })) });
});
app.get("/api/videos/:id", async (req, res) => {
  const video = await Video.findById(req.params.id);
  if (!video) return res.status(404).json({ error: "Not found" });
  res.json({ data: { ...video.toObject(), ...makeLinks(req, video._id) } });
});
app.post("/api/videos", authMiddleware, async (req, res) => {
  const video = await Video.create(req.body);
  res.status(201).json({ data: { ...video.toObject(), ...makeLinks(req, video._id) } });
});
app.patch("/api/videos/:id", authMiddleware, async (req, res) => {
  const video = await Video.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ data: { ...video.toObject(), ...makeLinks(req, video._id) } });
});
app.delete("/api/videos/:id", authMiddleware, async (req, res) => {
  await Video.findByIdAndDelete(req.params.id);
  res.json({ data: { success: true } });
});

// ── CORS Bypass Proxy ─────────────────────────────────────────
// Handles range requests so video seeking works correctly
app.get("/api/proxy", async (req, res) => {
  const target = decodeURIComponent(req.query.url || "");
  if (!target) return res.status(400).json({ error: "Missing url param" });

  // Block non-http/https URLs for safety
  if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: "Invalid URL" });

  try {
    const isRange  = !!req.headers["range"];
    const isHead   = req.method === "HEAD";

    const upstreamHeaders = {
      "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
      "Accept":          "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "identity",           // no gzip — we stream raw bytes
      "Referer":         "https://archive.org/",
      "Origin":          "https://archive.org",
      "Connection":      "keep-alive",
    };

    if (isRange) upstreamHeaders["Range"] = req.headers["range"];

    const upstream = await axios({
      method:       isHead ? "head" : "get",
      url:          target,
      responseType: isHead ? "stream" : "stream",
      headers:      upstreamHeaders,
      timeout:      60000,          // 60s — archive.org can be slow to start
      maxRedirects: 10,
      httpAgent,
      httpsAgent,
      decompress:   false,          // don't decompress — pass raw
    });

    // ── CORS response headers ──────────────────────────────────
    res.setHeader("Access-Control-Allow-Origin",      "*");
    res.setHeader("Access-Control-Allow-Headers",     "*");
    res.setHeader("Access-Control-Allow-Methods",     "GET, HEAD, OPTIONS");
    res.setHeader("Cross-Origin-Resource-Policy",     "cross-origin");
    res.setHeader("Cross-Origin-Embedder-Policy",     "unsafe-none");
    res.setHeader("Accept-Ranges",                    "bytes");

    // ── Forward content headers ────────────────────────────────
    const forward = ["content-type","content-length","content-range","last-modified","etag"];
    forward.forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });

    // Status: 206 for range, otherwise mirror upstream
    const status = isRange ? 206 : (upstream.status >= 200 && upstream.status < 300 ? 200 : upstream.status);
    res.status(status);

    if (isHead) return res.end();

    // Pipe stream — abort upstream if client disconnects
    req.on("close", () => {
      if (upstream.data?.destroy) upstream.data.destroy();
    });

    upstream.data.pipe(res);

  } catch (e) {
    const status = e.response?.status || 502;
    const msg    = e.response?.statusText || e.message || "Proxy fetch failed";
    console.error("[Proxy error]", status, msg, target);
    if (!res.headersSent) res.status(status).json({ error: msg });
  }
});

// Handle OPTIONS preflight for proxy
app.options("/api/proxy", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.sendStatus(204);
});

// Also support HEAD on proxy for metadata checks (video duration etc.)
app.head("/api/proxy", async (req, res) => {
  req.method = "HEAD";
  // Reuse GET handler logic — express won't match GET for HEAD automatically here
  const target = decodeURIComponent(req.query.url || "");
  if (!target) return res.status(400).end();
  try {
    const upstream = await axios.head(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer":    "https://archive.org/",
        "Origin":     "https://archive.org",
      },
      timeout: 20000,
      maxRedirects: 10,
      httpsAgent,
      httpAgent,
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");
    ["content-type","content-length"].forEach(h => {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    });
    res.status(200).end();
  } catch {
    res.status(502).end();
  }
});

// ── SPA fallback ──────────────────────────────────────────────
app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`KiroPlayr running on port ${PORT}`));
