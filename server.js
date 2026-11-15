const express = require('express');
const Database = require('better-sqlite3');
const cookieSession = require('cookie-session');
const path = require('path');

const app = express();
const db = new Database('geoattend.db');

app.use(express.json({ limit: '10mb' }));
app.use(cookieSession({ name: 'geoattend_sess', keys: ['geoattend-2026-rect'], maxAge: 7 * 86400 * 1000 }));
app.use(express.static(path.join(__dirname, 'public')));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT UNIQUE, email TEXT, name TEXT, role TEXT,
    full_name TEXT, roll_no TEXT, department TEXT,
    photo TEXT, descriptor TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lecturer_id INTEGER, title TEXT, code TEXT UNIQUE,
    lat REAL, lng REAL,
    shape TEXT DEFAULT 'rect',
    radius INTEGER DEFAULT 30,
    length INTEGER DEFAULT 20,
    width INTEGER DEFAULT 15,
    angle INTEGER DEFAULT 0,
    minutes INTEGER DEFAULT 1,
    ended INTEGER DEFAULT 0, created INTEGER
  );
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER, student_id INTEGER,
    face_verified INTEGER DEFAULT 0, secs INTEGER DEFAULT 0,
    lat REAL, lng REAL, accuracy REAL, in_now INTEGER DEFAULT 0,
    last_ping INTEGER, marked_at INTEGER,
    UNIQUE(event_id, student_id)
  );
`);

const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// Checks both Circular & Rectangular/Square (Rotated) Classroom Boundaries
function checkGeofence(ev, stuLat, stuLng, accuracy) {
  const buffer = Math.min(accuracy || 0, 15); // 15m indoor GPS buffer
  const dist = getDistanceMeters(ev.lat, ev.lng, stuLat, stuLng);

  if (ev.shape === 'circle') {
    return { inside: dist <= (ev.radius + buffer), dist };
  }

  // Convert Lat/Lng offset to local East (dx) and North (dy) in metres
  const dy = (stuLat - ev.lat) * 111320;
  const dx = (stuLng - ev.lng) * 111320 * Math.cos((ev.lat * Math.PI) / 180);

  // Rotate according to classroom orientation angle
  const rad = ((ev.angle || 0) * Math.PI) / 180;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);

  const halfL = (ev.length || 20) / 2 + buffer;
  const halfW = (ev.width || 15) / 2 + buffer;

  const inside = Math.abs(rx) <= halfL && Math.abs(ry) <= halfW;
  return { inside, dist };
}

const euclideanDistance = (d1, d2) => Math.sqrt(d1.reduce((s, v, i) => s + (v - d2[i]) ** 2, 0));

const auth = (req, res, next) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  req.user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!req.user) return res.status(401).json({ error: 'User not found' });
  next();
};

const handleLogin = (req, res) => {
  const rawName = (req.body.demoName || '').trim();
  if (!rawName) return res.status(400).json({ error: 'Please enter your name' });
  const sub = 'user_' + rawName.toLowerCase().replace(/\W+/g, '_');
  let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(sub);
  if (!user) {
    const info = db.prepare('INSERT INTO users (google_id, email, name) VALUES (?, ?, ?)').run(sub, sub + '@campus.edu', rawName);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  }
  req.session.userId = user.id;
  res.json({ ok: true });
};
app.post('/api/auth/login', handleLogin);
app.post('/api/auth/google', handleLogin);

app.get('/api/me', auth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, name: u.name, role: u.role, profile: u.roll_no ? { fullName: u.full_name, rollNo: u.roll_no, dept: u.department } : null });
});

app.post('/api/role', auth, (req, res) => {
  if (req.user.role) return res.status(400).json({ error: 'Role already locked' });
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.body.role, req.user.id);
  res.json({ ok: true });
});

app.post('/api/profile', auth, (req, res) => {
  const { fullName, rollNo, department, photo, descriptor } = req.body;
  if (!fullName || !rollNo || !descriptor || descriptor.length !== 128) {
    return res.status(400).json({ error: 'All fields and face scan are required.' });
  }
  const dupRoll = db.prepare('SELECT id FROM users WHERE LOWER(roll_no) = LOWER(?) AND id != ?').get(rollNo.trim(), req.user.id);
  if (dupRoll) return res.status(400).json({ error: 'Roll Number already registered by another student!' });

  const others = db.prepare('SELECT full_name, roll_no, descriptor FROM users WHERE descriptor IS NOT NULL AND id != ?').all(req.user.id);
  for (const other of others) {
    const saved = JSON.parse(other.descriptor || '[]');
    if (saved.length === 128 && euclideanDistance(saved, descriptor) < 0.48) {
      return res.status(403).json({ error: `Multi-Face Blocked: This face is already registered with ${other.full_name} (Roll No: ${other.roll_no})!` });
    }
  }
  db.prepare('UPDATE users SET full_name = ?, roll_no = ?, department = ?, photo = ?, descriptor = ? WHERE id = ?')
    .run(fullName.trim(), rollNo.trim(), (department || '').trim(), photo || '', JSON.stringify(descriptor), req.user.id);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.post('/api/events', auth, (req, res) => {
  const { title, lat, lng, shape, radius, length, width, angle, minutes } = req.body;
  if (!title || lat == null || lng == null) return res.status(400).json({ error: 'Title and GPS location required' });
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const info = db.prepare(`
    INSERT INTO events (lecturer_id, title, code, lat, lng, shape, radius, length, width, angle, minutes, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.user.id, title.trim(), code, lat, lng, shape || 'rect', radius || 30, length || 25, width || 15, angle || 0, minutes || 1, Date.now());
  res.json({ id: info.lastInsertRowid, code });
});

app.get('/api/events', auth, (req, res) => {
  res.json(db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM attendance a WHERE a.event_id = e.id AND a.marked_at IS NOT NULL) as present FROM events e WHERE lecturer_id = ? ORDER BY created DESC`).all(req.user.id));
});

app.get('/api/events/:id', auth, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND lecturer_id = ?').get(req.params.id, req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const attendees = db.prepare(`SELECT a.*, u.full_name, u.roll_no, u.department, u.photo FROM attendance a JOIN users u ON u.id = a.student_id WHERE a.event_id = ? ORDER BY u.roll_no ASC`).all(event.id);
  res.json({ event, attendees });
});

app.post('/api/events/:id/end', auth, (req, res) => {
  db.prepare('UPDATE events SET ended = 1 WHERE id = ? AND lecturer_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.get('/api/events/:id/csv', auth, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ? AND lecturer_id = ?').get(req.params.id, req.user.id);
  const rows = db.prepare(`SELECT u.full_name, u.roll_no, u.department, a.lat, a.lng, a.secs, a.marked_at FROM attendance a JOIN users u ON u.id = a.student_id WHERE a.event_id = ?`).all(event.id);
  const csv = ['Name,Roll No,Department,Geo-Tag (Lat Lng),Google Maps Proof,Minutes Inside,Status,Marked At',
    ...rows.map(r => [`"${r.full_name}"`, `"${r.roll_no}"`, `"${r.department}"`, `"${r.lat || ''}, ${r.lng || ''}"`, r.lat ? `"https://maps.google.com/?q=${r.lat},${r.lng}"` : '""', Math.floor(r.secs / 60), r.marked_at ? 'Present' : 'Incomplete', r.marked_at ? `"${new Date(r.marked_at).toLocaleString()}"` : '""'].join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${event.title.replace(/\W+/g, '_')}_GeoAttend.csv"`);
  res.send(csv);
});

app.get('/api/join/:code', auth, (req, res) => {
  const ev = db.prepare('SELECT * FROM events WHERE code = ?').get(req.params.code.toUpperCase());
  if (!ev || ev.ended) return res.status(400).json({ error: 'Invalid or ended event code' });
  res.json(ev);
});

app.post('/api/events/:id/face', auth, (req, res) => {
  const { descriptor } = req.body;
  const saved = JSON.parse(req.user.descriptor || '[]');
  if (!saved.length || euclideanDistance(saved, descriptor || []) > 0.55) {
    return res.status(403).json({ error: 'Face did not match your registered student profile!' });
  }
  db.prepare(`INSERT INTO attendance (event_id, student_id, face_verified, last_ping) VALUES (?, ?, 1, ?) ON CONFLICT(event_id, student_id) DO UPDATE SET face_verified = 1`).run(req.params.id, req.user.id, Date.now());
  res.json({ ok: true });
});

app.post('/api/checkin', auth, (req, res) => {
  const { eventId, lat, lng, accuracy } = req.body;
  const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!ev || ev.ended) return res.status(400).json({ error: 'Event ended', ended: true });
  const att = db.prepare('SELECT * FROM attendance WHERE event_id = ? AND student_id = ?').get(eventId, req.user.id);
  const now = Date.now();
  if (att.lat && att.lng && att.last_ping) {
    const jumped = getDistanceMeters(att.lat, att.lng, lat, lng), dt = (now - att.last_ping) / 1000;
    if (dt > 0 && (jumped / dt) > 35 && jumped > 150) return res.status(400).json({ error: 'Suspicious GPS jump detected (Anti-Spoofing).' });
  }

  const { inside, dist } = checkGeofence(ev, lat, lng, accuracy);
  const need = ev.minutes * 60;
  const secs = inside ? att.secs + (att.last_ping ? Math.min(15, Math.round((now - att.last_ping) / 1000)) : 5) : 0;
  const marked = att.marked_at || (secs >= need ? now : null);

  db.prepare(`UPDATE attendance SET secs = ?, lat = ?, lng = ?, accuracy = ?, in_now = ?, last_ping = ?, marked_at = ? WHERE id = ?`).run(secs, lat, lng, accuracy || 0, inside ? 1 : 0, now, marked, att.id);
  res.json({ dist, inside, secs, need, marked: Boolean(marked) });
});

app.get('/api/my-attendance', auth, (req, res) => {
  res.json(db.prepare(`SELECT e.title, e.created, a.marked_at, a.lat, a.lng FROM attendance a JOIN events e ON e.id = a.event_id WHERE a.student_id = ? ORDER BY e.created DESC`).all(req.user.id));
});

app.listen(3000, () => console.log('✅ GeoAttend v2 (Rectangular & Square Classroom Edition) -> http://localhost:3000'));
