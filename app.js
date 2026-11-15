const $ = s => document.querySelector(s);
const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.12/model/';
let me = null, pos = null, watchId = null, modelsP = null, stream = null, photo = null, descriptor = null, timers = [], wakeLock = null;
let lecMap = null, lecMarkers = [], stuMap = null, stuMarker = null;

// Computes 4 GPS corners of a rotated Rectangular/Square classroom
function getRectCorners(lat, lng, lengthM, widthM, angleDeg = 0) {
  const hw = widthM / 2, hl = lengthM / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const local = [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]];
  return local.map(([x, y]) => {
    const rx = x * Math.cos(rad) - y * Math.sin(rad);
    const ry = x * Math.sin(rad) + y * Math.cos(rad);
    const dLat = ry / 111320;
    const dLng = rx / (111320 * Math.cos((lat * Math.PI) / 180));
    return [lat + dLat, lng + dLng];
  });
}

const api = async (p, body) => {
  const r = await fetch('/api' + p, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed'), j); return j;
};
const el = (t, txt, cls) => { const e = document.createElement(t); if (txt != null) e.textContent = txt; if (cls) e.className = cls; return e; };
const show = id => { document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'v-' + id); };
const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const when = t => t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '–';
const clearTimers = () => { timers.forEach(clearInterval); timers = []; if (wakeLock) { wakeLock.release().catch(()=>{}); wakeLock = null; } };

$('#e-shape').onchange = () => {
  const isRect = $('#e-shape').value === 'rect';
  $('#rect-fields').hidden = !isRect;
  $('#circle-fields').hidden = isRect;
};

async function boot() {
  try { me = await api('/me'); } catch { me = null; }
  clearTimers(); $('#who').hidden = !me;
  if (!me) return show('auth');
  $('#whoName').textContent = me.name;
  $('#whoRole').textContent = me.role || 'User';
  if (!me.role) return show('role');
  await needLocation();
  if (me.role === 'lecturer') { show('home-l'); return loadEvents(); }
  if (!me.profile) return startProfile();
  show('home-s'); loadMine();
}

$('#demo-btn').onclick = async () => {
  const name = $('#demo-name').value.trim();
  if (!name) return $('#e-auth').textContent = 'Please enter your name.';
  try { await api('/auth/login', { demoName: name }); boot(); } catch (e) { $('#e-auth').textContent = e.message; }
};

$('#out').onclick = async () => { await api('/logout', {}); if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; pos = null; boot(); };
for (const r of ['student', 'lecturer']) $('#r-' + r).onclick = async () => {
  if (!confirm('Confirm role as ' + r.toUpperCase() + '?')) return;
  try { await api('/role', { role: r }); boot(); } catch (e) { $('#e-role').textContent = e.message; }
};

function needLocation() {
  if (pos) return Promise.resolve();
  show('loc');
  $('#locWhy').textContent = me.role === 'lecturer' ? 'Your GPS location becomes the center of the rectangular classroom.' : 'Verifies you are inside the classroom walls.';
  return new Promise(res => {
    $('#locBtn').onclick = () => navigator.geolocation.getCurrentPosition(p => {
      setPos(p); watchId = navigator.geolocation.watchPosition(setPos, () => {}, { enableHighAccuracy: true, maximumAge: 0 }); res();
    }, () => { $('#e-loc').textContent = 'Allow location access in browser settings.'; }, { enableHighAccuracy: true });
  });
}

const setPos = p => {
  pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
  if ($('#l-geotag')) $('#l-geotag').innerHTML = `📍 Live Geo-Tag: <strong>${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}</strong> (±${Math.round(pos.acc)}m) · <a href="https://maps.google.com/?q=${pos.lat},${pos.lng}" target="_blank">Google Maps ↗</a>`;
};

const loadModels = () => modelsP ||= Promise.all([
  faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
  faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
  faceapi.nets.faceRecognitionNet.loadFromUri(MODELS)
]);

async function startCam(video) {
  stopCam();
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640 }, audio: false });
  video.srcObject = stream;
  await new Promise(r => video.onloadedmetadata = r);
  await video.play();
}
const stopCam = () => { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const ear = e => (dist(e[1], e[5]) + dist(e[2], e[4])) / (2 * dist(e[0], e[3]));

async function scanFace(video, setMsg) {
  setMsg('⏳ Loading AI Biometric Models...');
  await loadModels();
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.35 });
  const t0 = Date.now();
  let state = 0, base = 0, n = 0, framesSeen = 0, noseBaseY = 0;

  while (Date.now() - t0 < 25000) {
    const allFaces = await faceapi.detectAllFaces(video, opts).withFaceLandmarks().withFaceDescriptors();
    if (allFaces.length > 1) {
      state = 0; n = 0; framesSeen = 0;
      setMsg('⚠️ Multiple faces detected! Only ONE student allowed.');
      await new Promise(r => setTimeout(r, 150));
      continue;
    }
    const d = allFaces[0];
    if (d) {
      framesSeen++;
      const e = (ear(d.landmarks.getLeftEye()) + ear(d.landmarks.getRightEye())) / 2;
      const noseY = d.landmarks.getNose()[3].y;
      if (state === 0) {
        base = (base * n + e) / (n + 1); noseBaseY = (noseBaseY * n + noseY) / (n + 1); n++;
        setMsg(`🔍 Scanning face (${Math.min(100, n * 25)}%)...`);
        if (n >= 4) state = 1;
      } else if (state === 1) {
        setMsg('😉 Blink or nod slightly...');
        if (e < base * 0.88 || e > base * 1.12 || Math.abs(noseY - noseBaseY) > 6 || framesSeen >= 16) state = 2;
      } else if (state === 2) {
        setMsg('✅ Verified!');
        const c = document.createElement('canvas');
        c.width = 240; c.height = Math.round(240 * (video.videoHeight || 240) / (video.videoWidth || 320));
        c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
        return { descriptor: Array.from(d.descriptor), photo: c.toDataURL('image/jpeg', 0.7) };
      }
    } else setMsg('👤 Center your face in the camera.');
    await new Promise(r => setTimeout(r, 60));
  }
  throw new Error('Scan timed out.');
}

function startProfile() { show('profile'); $('#p-name').value = me.name || ''; $('#p-photo').hidden = true; $('#p-save').disabled = true; $('#p-scan').disabled = true; }
$('#p-cam').onclick = async () => { try { await startCam($('#p-video')); $('#p-scan').disabled = false; $('#p-live').textContent = 'Camera ready.'; loadModels().catch(()=>{}); } catch (e) { $('#e-profile').textContent = e.message; } };
$('#p-scan').onclick = async () => {
  $('#p-scan').disabled = true;
  try { const r = await scanFace($('#p-video'), m => $('#p-live').textContent = m); photo = r.photo; descriptor = r.descriptor; $('#p-photo').src = photo; $('#p-photo').hidden = false; $('#p-save').disabled = false; stopCam(); }
  catch (e) { $('#e-profile').textContent = e.message; $('#p-scan').disabled = false; }
};
$('#p-save').onclick = async () => { try { await api('/profile', { fullName: $('#p-name').value, rollNo: $('#p-roll').value, department: $('#p-dept').value, photo, descriptor }); boot(); } catch (e) { $('#e-profile').textContent = e.message; } };

let ev = null;
$('#joinBtn').onclick = async () => {
  try { ev = await api('/join/' + encodeURIComponent($('#code').value.trim().toUpperCase())); show('scan'); $('#sc-title').textContent = ev.title; await startCam($('#s-video')); }
  catch (e) { $('#e-join').textContent = e.message; show('home-s'); }
};
$('#s-cancel').onclick = () => { stopCam(); show('home-s'); };
$('#s-go').onclick = async () => {
  $('#s-go').disabled = true;
  try { const r = await scanFace($('#s-video'), m => $('#e-scan').textContent = m); await api(`/events/${ev.id}/face`, { descriptor: r.descriptor }); stopCam(); startLive(); }
  catch (e) { $('#e-scan').textContent = e.message; } $('#s-go').disabled = false;
};

async function startLive() {
  show('live'); $('#l-title').textContent = ev.title; $('#l-n').textContent = ev.minutes + ' min';
  if ('wakeLock' in navigator) { try { wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
  if (pos) setPos({ coords: { latitude: pos.lat, longitude: pos.lng, accuracy: pos.acc } });

  setTimeout(() => {
    if (window.L && pos && ev.lat) {
      if (stuMap) stuMap.remove();
      stuMap = L.map('student-map').setView([ev.lat, ev.lng], 19);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(stuMap);
      if (ev.shape === 'circle') {
        L.circle([ev.lat, ev.lng], { radius: ev.radius, color: '#3fb950', fillOpacity: 0.2 }).addTo(stuMap);
      } else {
        L.polygon(getRectCorners(ev.lat, ev.lng, ev.length, ev.width, ev.angle), { color: '#3fb950', fillOpacity: 0.2 }).addTo(stuMap);
      }
      stuMarker = L.circleMarker([pos.lat, pos.lng], { radius: 8, color: '#58a6ff', fillOpacity: 1 }).addTo(stuMap).bindPopup('You').openPopup();
    }
  }, 200);

  const ping = async () => {
    if (!pos) return;
    try {
      const r = await api('/checkin', { eventId: ev.id, lat: pos.lat, lng: pos.lng, accuracy: pos.acc });
      if (stuMarker) stuMarker.setLatLng([pos.lat, pos.lng]);
      $('#l-d').textContent = Math.round(r.dist) + ' m'; $('#l-t').textContent = fmt(r.secs); $('#l-b').style.width = Math.min(100, r.secs / r.need * 100) + '%';
      const p = $('#l-pill');
      if (r.marked) { p.textContent = '✅ Present'; p.className = 'pill ok'; $('#l-msg').textContent = '🎉 Attendance Marked Inside Classroom!'; clearTimers(); }
      else if (r.inside) { p.textContent = '🟢 Inside Classroom'; p.className = 'pill ok'; $('#l-msg').textContent = 'Inside boundary: ' + fmt(Math.max(0, r.need - r.secs)) + ' remaining.'; }
      else { p.textContent = '🔴 Outside Room'; p.className = 'pill no'; $('#l-msg').textContent = 'Outside classroom walls! Timer reset.'; }
    } catch (e) { $('#l-msg').textContent = e.message; if (e.ended) clearTimers(); }
  };
  ping(); timers.push(setInterval(ping, 5000));
}

$('#l-leave').onclick = () => { clearTimers(); show('home-s'); loadMine(); };
async function loadMine() {
  const box = $('#mine'), rows = await api('/my-attendance').catch(() => []); box.textContent = rows.length ? '' : 'No records yet.';
  rows.forEach(r => {
    const d = el('div', null, 'ev');
    d.innerHTML = `<div><strong>${r.title}</strong> · <small class="mute">${when(r.created)}</small></div>`;
    d.append(el('span', r.marked_at ? 'Present' : 'Incomplete', 'pill ' + (r.marked_at ? 'ok' : 'no')));
    box.append(d);
  });
}

$('#e-go').onclick = async () => {
  try {
    const r = await api('/events', {
      title: $('#e-title').value, lat: pos.lat, lng: pos.lng,
      shape: $('#e-shape').value,
      length: +$('#e-len').value, width: +$('#e-wid').value, angle: +$('#e-ang').value,
      radius: +$('#e-rad').value, minutes: +$('#e-min').value
    });
    $('#e-title').value = ''; await loadEvents(); openEvent(r.id);
  } catch (e) { $('#e-create').textContent = e.message; }
};

async function loadEvents() {
  const list = await api('/events').catch(() => []), h = $('#hist'); h.textContent = list.length ? '' : 'No sessions yet.';
  list.forEach(e => {
    const shapeTxt = e.shape === 'circle' ? `${e.radius}m Circle` : `${e.length}m × ${e.width}m Room`;
    const row = el('div', null, 'ev'), b = el('button', 'Open', 's');
    b.onclick = () => openEvent(e.id);
    row.append(el('span', `${e.title} (${shapeTxt}) · ${e.present} Present`), b);
    h.append(row);
  });
}

function openEvent(id) {
  clearTimers(); lecMap = null;
  const draw = async () => {
    const { event: e, attendees: a } = await api('/events/' + id), d = $('#dash'); d.hidden = false;
    const shapeDesc = e.shape === 'circle' ? `⭕ ${e.radius}m Circular Zone` : `📐 ${e.length}m × ${e.width}m Rectangular Room (${e.angle}°)`;
    if (!d.querySelector('#lec-map')) {
      d.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center"><h2 id="d-title" style="margin:0"></h2><span id="d-status" class="pill"></span></div>
        <div class="code-box">
          <div><small class="mute">JOIN CODE</small><div id="d-code" class="code"></div><small id="d-meta" class="mute"></small></div>
          <div style="text-align:right"><small class="mute">CENTER GEO-TAG</small><div id="d-center" style="font-weight:700;margin-top:.2rem"></div></div>
        </div>
        <div id="lec-map" style="height:250px;border-radius:10px;margin:0.8rem 0;border:1px solid #2d3545"></div>
        <h3 id="d-count"></h3><div id="d-table" class="scroll"></div><div id="d-actions" style="margin-top:1rem"></div>
      `;
    }
    $('#d-title').textContent = e.title;
    $('#d-status').textContent = e.ended ? 'Ended' : '🟢 Live';
    $('#d-status').className = 'pill ' + (e.ended ? '' : 'ok');
    $('#d-code').textContent = e.code;
    $('#d-meta').textContent = `${shapeDesc} · ${e.minutes} min required`;
    $('#d-center').innerHTML = `<a href="https://maps.google.com/?q=${e.lat},${e.lng}" target="_blank">📍 ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)} ↗</a>`;
    $('#d-count').textContent = `Attendees (${a.length} joined, ${a.filter(x => x.marked_at).length} Present)`;

    if (window.L && e.lat && e.lng) {
      if (!lecMap) {
        lecMap = L.map('lec-map').setView([e.lat, e.lng], 19);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(lecMap);
        if (e.shape === 'circle') {
          L.circle([e.lat, e.lng], { radius: e.radius, color: '#3fb950', fillOpacity: 0.2 }).addTo(lecMap);
        } else {
          L.polygon(getRectCorners(e.lat, e.lng, e.length, e.width, e.angle), { color: '#3fb950', fillColor: '#3fb950', fillOpacity: 0.22 }).addTo(lecMap);
        }
        L.marker([e.lat, e.lng]).addTo(lecMap).bindPopup(`<b>Lecturer Center</b><br>${shapeDesc}`);
      }
      lecMarkers.forEach(m => m.remove()); lecMarkers = [];
      a.forEach(r => {
        if (r.lat && r.lng) {
          const m = L.circleMarker([r.lat, r.lng], { radius: 7, color: r.marked_at ? '#3fb950' : '#f0883e', fillOpacity: 1 })
            .addTo(lecMap).bindPopup(`<b>${r.full_name}</b> (${r.roll_no})`);
          lecMarkers.push(m);
        }
      });
    }

    const tb = $('#d-table'); tb.textContent = '';
    if (a.length) {
      const t = el('table'), hr = el('tr');
      ['Student', 'Roll No', 'Time', 'Geo-Tag Proof', 'Status'].forEach(x => hr.append(el('th', x))); t.append(hr);
      a.forEach(r => {
        const tr = el('tr'), nameTd = el('td'), geo = el('td'), st = el('td');
        if (r.photo) { const img = el('img', null, 'avatar'); img.src = r.photo; nameTd.append(img); }
        nameTd.append(el('span', r.full_name));
        geo.innerHTML = r.lat ? `<a href="https://maps.google.com/?q=${r.lat},${r.lng}" target="_blank">📍 ${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}</a>` : 'Verified';
        st.append(el('span', r.marked_at ? 'Present' : 'Tracking...', 'pill ' + (r.marked_at ? 'ok' : '')));
        tr.append(nameTd, el('td', r.roll_no), el('td', fmt(r.secs)), geo, st);
        t.append(tr);
      });
      tb.append(t);
    }

    const act = $('#d-actions'); act.textContent = '';
    const csv = el('button', '📥 Export Geo-Tagged CSV'); csv.onclick = () => location.href = `/api/events/${id}/csv`; act.append(csv);
    if (!e.ended) {
      const en = el('button', 'End Session', 'd');
      en.onclick = async () => { await api(`/events/${id}/end`, {}); clearTimers(); draw(); loadEvents(); };
      act.append(en);
    }
  };
  draw().then(() => timers.push(setInterval(() => draw().catch(()=>{}), 5000)));
}
boot();
