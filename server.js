const express = require('express');
const cookieSession = require('cookie-session');
const fs = require('fs');
const path = require('path');

const app = express();
const DATA_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DATA_FILE)) return { users: [], events: [], attendance: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { users: [], events: [], attendance: [] }; }
}
function saveDB(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

app.use(express.json({ limit: '10mb' }));
app.use(cookieSession({ name: 'geoattend_sess', keys: ['geoattend-2026-json'], maxAge: 7 * 86400 * 1000 }));
app.use(express.static(path.join(__dirname, 'public')));

const getDistanceMeters = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

function checkGeofence(ev, stuLat, stuLng, accuracy) {
  const buffer = Math.min(accuracy || 0, 15);
  const dist = getDistanceMeters(ev.lat, ev.lng, stuLat, stuLng);
  if (ev.shape === 'circle') return { inside: dist <= (ev.radius + buffer), dist };
  const dy = (stuLat - ev.lat) * 111320;
  const dx = (stuLng - ev.lng) * 111320 * Math.cos((ev.lat * Math.PI) / 180);
  const rad = ((ev.angle || 0) * Math.PI) / 180;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  const halfL = (ev.length || 30) / 2 + buffer;
  const halfW = (ev.width || 20) / 2 + buffer;
  return { inside: Math.abs(rx) <= halfL && Math.abs(ry) <= halfW, dist };
}

const euclideanDistance = (d1, d2) => Math.sqrt(d1.reduce((s, v, i) => s + (v - d2[i]) ** 2, 0));

const auth = (req, res, next) => {
  const db = loadDB();
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in' });
  req.user = db.users.find(u => u.id === req.session.userId);
  if (!req.user) return res.status(401).json({ error: 'User not found' });
  next();
};

const handleLogin = (req, res) => {
  const db = loadDB();
  const rawName = (req.body.demoName || '').trim();
  if (!rawName) return res.status(400).json({ error: 'Please enter your name' });
  const sub = 'user_' + rawName.toLowerCase().replace(/\W+/g, '_');
  let user = db.users.find(u => u.google_id === sub);
  if (!user) {
    user = { id: Date.now(), google_id: sub, email: sub + '@campus.edu', name: rawName, role: null };
    db.users.push(user);
    saveDB(db);
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
  const db = loadDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (user.role) return res.status(400).json({ error: 'Role already locked' });
  user.role = req.body.role;
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/profile', auth, (req, res) => {
  const db = loadDB();
  const { fullName, rollNo, department, photo, descriptor } = req.body;
  if (!fullName || !rollNo || !descriptor || descriptor.length !== 128) {
    return res.status(400).json({ error: 'All fields and face scan are required.' });
  }
  const dup = db.users.find(u => u.roll_no && u.roll_no.toLowerCase() === rollNo.trim().toLowerCase() && u.id !== req.user.id);
  if (dup) return res.status(400).json({ error: 'Roll Number already registered!' });

  for (const other of db.users) {
    if (other.descriptor && other.id !== req.user.id) {
      const saved = JSON.parse(other.descriptor);
      if (saved.length === 128 && euclideanDistance(saved, descriptor) < 0.48) {
        return res.status(403).json({ error: `Multi-Face Blocked: Registered with ${other.full_name} (Roll: ${other.roll_no})!` });
      }
    }
  }
  const user = db.users.find(u => u.id === req.user.id);
  user.full_name = fullName.trim();
  user.roll_no = rollNo.trim();
  user.department = (department || '').trim();
  user.photo = photo || '';
  user.descriptor = JSON.stringify(descriptor);
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.post('/api/events', auth, (req, res) => {
  const db = loadDB();
  const { title, lat, lng, shape, radius, length, width, angle, minutes } = req.body;
  if (!title || lat == null || lng == null) return res.status(400).json({ error: 'Title and GPS required' });
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const ev = {
    id: Date.now(), lecturer_id: req.user.id, title: title.trim(), code, lat, lng,
    shape: shape || 'rect', radius: radius || 30, length: length || 30, width: width || 20, angle: angle || 0,
    minutes: minutes || 1, ended: 0, created: Date.now()
  };
  db.events.push(ev);
  saveDB(db);
  res.json({ id: ev.id, code });
});

app.get('/api/events', auth, (req, res) => {
  const db = loadDB();
  const events = db.events.filter(e => e.lecturer_id === req.user.id).map(e => {
    const presentCount = db.attendance.filter(a => a.event_id === e.id && a.marked_at).length;
    return { ...e, present: presentCount };
  }).sort((a, b) => b.created - a.created);
  res.json(events);
});

app.get('/api/events/:id', auth, (req, res) => {
  const db = loadDB();
  const event = db.events.find(e => e.id == req.params.id && e.lecturer_id === req.user.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  const attendees = db.attendance.filter(a => a.event_id == event.id).map(a => {
    const u = db.users.find(user => user.id === a.student_id) || {};
    return { ...a, full_name: u.full_name, roll_no: u.roll_no, department: u.department, photo: u.photo };
  }).sort((a, b) => (a.roll_no || '').localeCompare(b.roll_no || ''));
  res.json({ event, attendees });
});

app.post('/api/events/:id/end', auth, (req, res) => {
  const db = loadDB();
  const ev = db.events.find(e => e.id == req.params.id && e.lecturer_id === req.user.id);
  if (ev) { ev.ended = 1; saveDB(db); }
  res.json({ ok: true });
});

app.get('/api/events/:id/csv', auth, (req, res) => {
  const db = loadDB();
  const event = db.events.find(e => e.id == req.params.id && e.lecturer_id === req.user.id);
  if (!event) return res.status(404).send('Not found');
  const rows = db.attendance.filter(a => a.event_id == event.id).map(a => {
    const u = db.users.find(user => user.id === a.student_id) || {};
    return { ...a, full_name: u.full_name, roll_no: u.roll_no, department: u.department };
  });
  const csv = ['Name,Roll No,Department,Geo-Tag (Lat Lng),Google Maps Proof,Minutes Inside,Status,Marked At',
    ...rows.map(r => [`"${r.full_name}"`, `"${r.roll_no}"`, `"${r.department}"`, `"${r.lat || ''}, ${r.lng || ''}"`, r.lat ? `"https://maps.google.com/?q=${r.lat},${r.lng}"` : '""', Math.floor(r.secs / 60), r.marked_at ? 'Present' : 'Incomplete', r.marked_at ? `"${new Date(r.marked_at).toLocaleString()}"` : '""'].join(','))
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${event.title.replace(/\W+/g, '_')}_GeoAttend.csv"`);
  res.send(csv);
});

app.get('/api/join/:code', auth, (req, res) => {
  const db = loadDB();
  const ev = db.events.find(e => e.code === req.params.code.toUpperCase());
  if (!ev || ev.ended) return res.status(400).json({ error: 'Invalid or ended event code' });
  res.json(ev);
});

app.post('/api/events/:id/face', auth, (req, res) => {
  const db = loadDB();
  const { descriptor } = req.body;
  const saved = JSON.parse(req.user.descriptor || '[]');
  if (!saved.length || euclideanDistance(saved, descriptor || []) > 0.55) {
    return res.status(403).json({ error: 'Face did not match your registered profile!' });
  }
  let att = db.attendance.find(a => a.event_id == req.params.id && a.student_id === req.user.id);
  if (!att) {
    att = { id: Date.now(), event_id: +req.params.id, student_id: req.user.id, face_verified: 1, secs: 0, lat: null, lng: null, accuracy: 0, in_now: 0, last_ping: Date.now(), marked_at: null };
    db.attendance.push(att);
  } else {
    att.face_verified = 1;
    att.last_ping = Date.now();
  }
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/checkin', auth, (req, res) => {
  const db = loadDB();
  const { eventId, lat, lng, accuracy } = req.body;
  const ev = db.events.find(e => e.id == eventId);
  if (!ev || ev.ended) return res.status(400).json({ error: 'Event ended', ended: true });
  let att = db.attendance.find(a => a.event_id == eventId && a.student_id === req.user.id);
  if (!att) return res.status(400).json({ error: 'Join event first' });

  const now = Date.now();
  if (att.lat && att.lng && att.last_ping) {
    const jumped = getDistanceMeters(att.lat, att.lng, lat, lng), dt = (now - att.last_ping) / 1000;
    if (dt > 0 && (jumped / dt) > 35 && jumped > 150) return res.status(400).json({ error: 'GPS jump detected.' });
  }

  const { inside, dist } = checkGeofence(ev, lat, lng, accuracy);
  const need = ev.minutes * 60;
  const secs = inside ? att.secs + (att.last_ping ? Math.min(15, Math.round((now - att.last_ping) / 1000)) : 5) : 0;
  const marked = att.marked_at || (secs >= need ? now : null);

  att.secs = secs;
  att.lat = lat;
  att.lng = lng;
  att.accuracy = accuracy || 0;
  att.in_now = inside ? 1 : 0;
  att.last_ping = now;
  att.marked_at = marked;
  saveDB(db);

  res.json({ dist, inside, secs, need, marked: Boolean(marked) });
});

app.get('/api/my-attendance', auth, (req, res) => {
  const db = loadDB();
  const rows = db.attendance.filter(a => a.student_id === req.user.id).map(a => {
    const e = db.events.find(event => event.id === a.event_id) || {};
    return { title: e.title, created: e.created, marked_at: a.marked_at, lat: a.lat, lng: a.lng };
  }).sort((a, b) => b.created - a.created);
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('✅ GeoAttend JSON Server running on port ' + PORT));
