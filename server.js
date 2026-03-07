// =========================================================
// KiroPlayr server.js — standalone Express version
// =========================================================
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

const MONGO_URI =
  "mongodb+srv://ryoevisu:XaneKath1@cluster0.5hy2uez.mongodb.net/kiroplayr?appName=Cluster0";
const JWT_SECRET = "kiroplayr_secret_key_2024";
const PORT = process.env.PORT || 3000;

// ── DB ──────────────────────────────────────────────────
mongoose.connect(MONGO_URI).then(() => console.log("[DB] Connected"));

const AdminSchema = new mongoose.Schema({ username: { type: String, unique: true }, password: String });
const FolderSchema = new mongoose.Schema({ name: String }, { timestamps: true });
const VideoSchema = new mongoose.Schema(
  { folderId: mongoose.Schema.Types.ObjectId, title: String, url: String },
  { timestamps: true }
);
const Admin = mongoose.model("Admin", AdminSchema);
const Folder = mongoose.model("Folder", FolderSchema);
const Video = mongoose.model("Video", VideoSchema);

// Seed admin
async function seedAdmin() {
  const exists = await Admin.findOne({ username: "kiro" });
  if (!exists) {
    await Admin.create({ username: "kiro", password: await bcrypt.hash("XaneKath1", 10) });
    console.log("[Auth] Admin seeded");
  }
}
seedAdmin();

// ── Auth middleware ──────────────────────────────────────
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

// ── Auth routes ──────────────────────────────────────────
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body;
  const admin = await Admin.findOne({ username });
  if (!admin || !(await bcrypt.compare(password, admin.password)))
    return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ sub: admin._id, username: admin.username }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ data: { token, username: admin.username } });
});

// ── Folder routes ────────────────────────────────────────
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
  res.json({ data: { success: true } });
});

// ── Video routes ─────────────────────────────────────────
function makeLinks(req, id) {
  const base = req.protocol + "://" + req.get("host");
  return {
    directUrl: base + "/api/proxy?url=" + encodeURIComponent(base + "/api/videos/" + id),
    embedUrl: base + "/embed/" + id,
  };
}
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

// ── CORS Bypass Proxy (for archive.org etc.) ─────────────
app.get("/api/proxy", async (req, res) => {
  const target = decodeURIComponent(req.query.url || "");
  if (!target) return res.status(400).json({ error: "Missing url param" });
  try {
    const range = req.headers["range"];
    const upstream = await axios.get(target, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
        'Referer': 'https://archive.org/',
        'Origin': 'https://archive.org',
        ...(range ? { Range: range } : {}),
      },
      timeout: 30000,
      maxRedirects: 5,
    });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Accept-Ranges', 'bytes');
    const ct = upstream.headers['content-type'];
    if (ct) res.setHeader('Content-Type', ct);
    const cl = upstream.headers['content-length'];
    if (cl) res.setHeader('Content-Length', cl);
    const cr = upstream.headers['content-range'];
    if (cr) res.setHeader('Content-Range', cr);
    res.status(range ? 206 : upstream.status);
    upstream.data.pipe(res);
  } catch (e) {
    res.status(502).json({ error: "Proxy fetch failed" });
  }
});
app.options("/api/proxy", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.sendStatus(204);
});

app.listen(PORT, () => console.log("KiroPlayr running on port", PORT));
