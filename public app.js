// --- GEOATTEND FRONTEND APP ---
let currentUser = null;
let currentRole = null;
let videoStream = null;
let faceMatcher = null;

async function api(endpoint, method = 'GET', data = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(endpoint, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Server error');
  return json;
}

async function init() {
  try {
    const me = await api('/api/me');
    currentUser = me;
    currentRole = me.role;
    if (!currentRole) {
      showRoleSelector();
    } else if (currentRole === 'student' && !me.profile) {
      showStudentProfileSetup();
    } else if (currentRole === 'lecturer') {
      showLecturerDashboard();
    } else {
      showStudentDashboard();
    }
  } catch {
    showLoginScreen();
  }
}

function showLoginScreen() {
  document.getElementById('app').innerHTML = `
    <div style="max-width: 400px; margin: 80px auto; padding: 30px; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center;">
      <h2 style="color: #2563eb; margin-bottom: 10px;">GeoAttend AI</h2>
      <p style="color: #64748b; margin-bottom: 25px;">Smart Geofence & Face Recognition Attendance</p>
      <input type="text" id="demoName" placeholder="Enter your full name" style="width: 100%; padding: 12px; margin-bottom: 15px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 16px;">
      <button onclick="handleLogin()" style="width: 100%; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">Continue</button>
    </div>
  `;
}

async function handleLogin() {
  const name = document.getElementById('demoName').value.trim();
  if (!name) return alert('Please enter your name');
  try {
    await api('/api/auth/login', 'POST', { demoName: name });
    init();
  } catch (err) {
    alert(err.message);
  }
}

function showRoleSelector() {
  document.getElementById('app').innerHTML = `
    <div style="max-width: 450px; margin: 80px auto; padding: 30px; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center;">
      <h3 style="margin-bottom: 20px; color: #1e293b;">Select Your Role</h3>
      <div style="display: flex; gap: 15px; justify-content: center;">
        <button onclick="setRole('student')" style="flex: 1; padding: 15px; background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">Student</button>
        <button onclick="setRole('lecturer')" style="flex: 1; padding: 15px; background: #f8fafc; border: 2px solid #cbd5e1; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer;">Lecturer</button>
      </div>
    </div>
  `;
}

async function setRole(role) {
  try {
    await api('/api/role', 'POST', { role });
    init();
  } catch (err) {
    alert(err.message);
  }
}

function showStudentProfileSetup() {
  document.getElementById('app').innerHTML = `
    <div style="max-width: 500px; margin: 40px auto; padding: 30px; background: white; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">
      <h3 style="margin-bottom: 15px; color: #1e293b;">Student Profile & Face Registration</h3>
      <input type="text" id="fullName" placeholder="Full Name" style="width: 100%; padding: 10px; margin-bottom: 10px; border: 1px solid #cbd5e1; border-radius: 6px;">
      <input type="text" id="rollNo" placeholder="Roll Number" style="width: 100%; padding: 10px; margin-bottom: 10px; border: 1px solid #cbd5e1; border-radius: 6px;">
      <input type="text" id="department" placeholder="Department / Branch" style="width: 100%; padding: 10px; margin-bottom: 15px; border: 1px solid #cbd5e1; border-radius: 6px;">
      <div style="text-align: center; margin-bottom: 15px;">
        <video id="webcam" autoplay playsinline width="320" height="240" style="background: #000; border-radius: 8px;"></video>
      </div>
      <button onclick="captureProfileFace()" style="width: 100%; padding: 12px; background: #2563eb; color: white; border: none; border-radius: 8px; font-weight: 600; cursor: pointer;">Capture Face & Register</button>
    </div>
  `;
  startCamera();
}

async function startCamera() {
  try {
    videoStream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
