const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const db = require("./db");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

// Singapore public holidays (editable in-app; used to exclude non-work days)
const SEED_HOLIDAYS = [
  { date: "2026-01-01", name: "New Year's Day" },
  { date: "2026-02-17", name: "Chinese New Year" },
  { date: "2026-02-18", name: "Chinese New Year (Day 2)" },
  { date: "2026-03-21", name: "Hari Raya Puasa" },
  { date: "2026-04-03", name: "Good Friday" },
  { date: "2026-05-01", name: "Labour Day" },
  { date: "2026-05-27", name: "Hari Raya Haji" },
  { date: "2026-05-31", name: "Vesak Day" },
  { date: "2026-06-01", name: "Vesak Day (observed)" },
  { date: "2026-08-09", name: "National Day" },
  { date: "2026-08-10", name: "National Day (observed)" },
  { date: "2026-11-08", name: "Deepavali" },
  { date: "2026-11-09", name: "Deepavali (observed)" },
  { date: "2026-12-25", name: "Christmas Day" },
  { date: "2027-01-01", name: "New Year's Day" }
];

const LEAVE_TYPES = ["MC", "Annual Leave", "Hospitalisation", "Childcare", "Unpaid Leave", "Going to site", "Other"];

function defaultData() {
  return {
    members: [],
    entries: [],
    holidays: SEED_HOLIDAYS.map((h, i) => ({ id: "seed" + i, ...h }))
  };
}

function isDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    const data = await db.load();
    const d = data || defaultData();
    return json(res, 200, { members: d.members, entries: d.entries, holidays: d.holidays, types: LEAVE_TYPES });
  }

  if (req.method === "POST" && url.pathname === "/api/members") {
    const b = await readBody(req);
    const name = String(b.name || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!name) throw new HttpError(400, "Name is required.");
    const member = await db.mutate((data) => {
      if (data.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(400, name + " is already on the team.");
      }
      const m = { id: newId(), name, createdAt: new Date().toISOString() };
      data.members.push(m);
      return m;
    });
    return json(res, 201, member);
  }

  const memMatch = url.pathname.match(/^\/api\/members\/([a-z0-9]+)$/i);
  if (memMatch && req.method === "DELETE") {
    const removed = await db.mutate((data) => {
      const idx = data.members.findIndex((m) => m.id === memMatch[1]);
      if (idx === -1) throw new HttpError(404, "Member not found.");
      const [r] = data.members.splice(idx, 1);
      data.entries = data.entries.filter((e) => e.memberId !== r.id);
      return r;
    });
    return json(res, 200, removed);
  }

  if (req.method === "POST" && url.pathname === "/api/entries") {
    const b = await readBody(req);
    const memberId = String(b.memberId || "").trim();
    const type = String(b.type || "").trim();
    const start = String(b.start || "").trim();
    const end = String(b.end || start).trim();
    const note = String(b.note || "").trim().slice(0, 200);

    if (!LEAVE_TYPES.includes(type)) throw new HttpError(400, "Invalid leave type.");
    if (!isDate(start) || !isDate(end)) throw new HttpError(400, "Invalid date(s).");
    if (end < start) throw new HttpError(400, "End date must not be before start date.");
    if (Math.round((Date.parse(end) - Date.parse(start)) / 86400000) > 365) {
      throw new HttpError(400, "Leave span too long (max 365 days).");
    }

    const entry = await db.mutate((data) => {
      const member = data.members.find((m) => m.id === memberId);
      if (!member) throw new HttpError(400, "Pick a teammate first (add them at the top if new).");
      const dup = data.entries.find((e) => e.memberId === memberId && e.start <= end && start <= e.end);
      if (dup) throw new HttpError(400, member.name + " already has a leave entry overlapping those dates.");
      const e = {
        id: newId(),
        memberId,
        name: member.name,
        type,
        start,
        end,
        note,
        createdAt: new Date().toISOString()
      };
      data.entries.push(e);
      return e;
    });
    return json(res, 201, entry);
  }

  const entMatch = url.pathname.match(/^\/api\/entries\/([a-z0-9]+)$/i);
  if (entMatch && req.method === "DELETE") {
    const removed = await db.mutate((data) => {
      const idx = data.entries.findIndex((e) => e.id === entMatch[1]);
      if (idx === -1) throw new HttpError(404, "Entry not found.");
      const [r] = data.entries.splice(idx, 1);
      return r;
    });
    return json(res, 200, removed);
  }

  if (req.method === "POST" && url.pathname === "/api/holidays") {
    const b = await readBody(req);
    const date = String(b.date || "").trim();
    const name = String(b.name || "").trim().slice(0, 60) || "Public Holiday";
    if (!isDate(date)) throw new HttpError(400, "Invalid date.");
    const holiday = await db.mutate((data) => {
      if (data.holidays.some((h) => h.date === date)) throw new HttpError(400, "That date is already a holiday.");
      const h = { id: newId(), date, name };
      data.holidays.push(h);
      return h;
    });
    return json(res, 201, holiday);
  }

  const holMatch = url.pathname.match(/^\/api\/holidays\/([a-z0-9]+)$/i);
  if (holMatch && req.method === "DELETE") {
    const removed = await db.mutate((data) => {
      const idx = data.holidays.findIndex((h) => h.id === holMatch[1]);
      if (idx === -1) throw new HttpError(404, "Holiday not found.");
      const [r] = data.holidays.splice(idx, 1);
      return r;
    });
    return json(res, 200, removed);
  }

  throw new HttpError(404, "Not found.");
}

function serveStatic(req, res, url) {
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  p = path.normalize(p).replace(/^([.][.][\\/])+/, "");
  const file = path.join(PUBLIC_DIR, p);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else if (req.method === "GET") {
      serveStatic(req, res, url);
    } else {
      res.writeHead(405);
      res.end();
    }
  } catch (e) {
    json(res, e.code || 400, { error: e.message || "Bad request" });
  }
});

async function start() {
  const seed = defaultData();
  if (db.USE_DB) {
    await db.init(seed);
  } else {
    const cur = await db.load();
    if (!cur) await db.save(seed);
  }
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`ITeFM Attendance Tracker running:`);
    console.log(`  Local (this PC):  http://localhost:${PORT}`);
    for (const f of Object.values(os.networkInterfaces()).flat()) {
      if (f && f.family === "IPv4" && !f.internal) {
        console.log(`  Network (team):   http://${f.address}:${PORT}`);
        break;
      }
    }
    console.log(`Storage: ${db.USE_DB ? "Postgres (DATABASE_URL)" : "data.json"}`);
  });
}

start().catch((e) => {
  console.error("Failed to start:", e.message);
  process.exit(1);
});
