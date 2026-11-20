/* AI-Assisted Smart Waste Management - script.js */
'use strict';

/* ---------- Config & helpers ---------- */
const CATEGORIES = ['Plastic', 'Paper', 'Food waste', 'Metal', 'Glass', 'Other'];
const RECYCLABLE = ['Plastic', 'Paper', 'Metal', 'Glass'];
const COLORS = { Plastic: '#2f9e5b', Paper: '#5aa9e6', 'Food waste': '#e0a21b', Metal: '#7c8a93', Glass: '#14b8a6', Other: '#b9c4be' };
const ICONS = { Plastic: '🧴', Paper: '📄', 'Food waste': '🍌', Metal: '🥫', Glass: '🍾', Other: '🗑️', Mixed: '🗑️' };
const API_MODEL = 'claude-sonnet-4-6';
var DB = { reports: [], history: [] }, ME = null, AI_ON = false;
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = {}; try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) { const e = new Error(data.message || 'Request failed (' + res.status + ')'); e.code = data.error; throw e; }
  return data;
}
async function refreshData() {
  const [r, h] = await Promise.all([api('/api/reports'), api('/api/detections')]);
  DB.reports = r.reports; DB.history = h.detections;
  renderReports(); renderDashboard();
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmtDate = (t) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const normCat = (c) => {
  const s = String(c || '').toLowerCase();
  if (s.includes('plastic')) return 'Plastic';
  if (s.includes('paper') || s.includes('card')) return 'Paper';
  if (s.includes('food') || s.includes('organic')) return 'Food waste';
  if (s.includes('metal') || s.includes('can')) return 'Metal';
  if (s.includes('glass')) return 'Glass';
  return 'Other';
};
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* Resize an image file to a data URL (keeps upload payloads small) */
function resizeImage(file, max, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('This file is not a valid image.'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function imageProblem(file) {
  if (!file) return 'Choose an image first.';
  if (!file.type.startsWith('image/')) return 'Please choose an image file (JPG, PNG or WebP).';
  if (file.size > 5 * 1024 * 1024) return 'Image is larger than 5 MB. Choose a smaller one.';
  return '';
}

/* ---------- Navigation ---------- */
const navToggle = $('navToggle'), navMenu = $('navMenu');
navToggle.addEventListener('click', () => {
  const open = navMenu.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', open);
});
navMenu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => { navMenu.classList.remove('open'); navToggle.setAttribute('aria-expanded', false); }));
/* page router: each nav item shows its own page */
const views = [...document.querySelectorAll('main .view')];
const links = [...navMenu.querySelectorAll('a')];
function route() {
  const want = (window.location.hash || '#home').slice(1);
  const id = views.some((v) => v.id === want) ? want : 'home';
  views.forEach((v) => v.classList.toggle('active', v.id === id));
  links.forEach((l) => l.classList.toggle('active', l.getAttribute('href') === '#' + id));
  window.scrollTo({ top: 0 });
  if (id === 'dashboard') renderDashboard();
  if (id === 'reports' && map) setTimeout(() => map.invalidateSize(), 60);
}
window.addEventListener('hashchange', route);

/* ---------- AI detection ---------- */
let currentFile = null;
const drop = $('drop'), input = $('imageInput'), preview = $('preview');

function setFile(file) {
  const problem = imageProblem(file);
  $('imgErr').textContent = problem;
  if (problem) { currentFile = null; preview.hidden = true; $('dropText').hidden = false; return; }
  currentFile = file;
  preview.src = URL.createObjectURL(file); preview.hidden = false; $('dropText').hidden = true;
}
input.addEventListener('change', () => input.files[0] && setFile(input.files[0]));
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && setFile(e.dataTransfer.files[0]));

$('clearBtn').addEventListener('click', () => {
  currentFile = null; input.value = ''; preview.hidden = true; preview.removeAttribute('src');
  $('dropText').hidden = false; $('detLocation').value = ''; $('imgErr').textContent = ''; $('locErr').textContent = '';
  $('resultBody').hidden = true; $('resultEmpty').hidden = false;
});

function refreshApiBadge() { $('apiBadge').textContent = AI_ON ? 'AI ready' : 'AI not configured'; $('apiBadge').classList.toggle('on', AI_ON); }

async function callAnalyze(file, location) {
  const image = await resizeImage(file, 1280, 0.85), thumb = await resizeImage(file, 96, 0.6);
  return api('/api/analyze', { method: 'POST', body: { image, thumb, location, ...pinData() } });
}

$('analyzeBtn').addEventListener('click', async () => {
  if (!requireLogin()) return;
  const location = $('detLocation').value.trim();
  $('imgErr').textContent = imageProblem(currentFile);
  $('locErr').textContent = location.length < 3 ? 'Enter the location name (at least 3 characters).' : '';
  $('detLocation').classList.toggle('invalid', location.length < 3);
  if ($('imgErr').textContent || $('locErr').textContent) return;

  $('resultEmpty').hidden = true; $('resultBody').hidden = false;
  if (!AI_ON) { showManual(location); return; }

  const btn = $('analyzeBtn'); btn.disabled = true; btn.textContent = 'Analyzing...';
  $('resultBody').innerHTML = '<div class="spinner" aria-label="Analyzing"></div><p style="text-align:center">Analyzing image with the AI model...</p>';
  try {
    const out = await callAnalyze(currentFile, location);
    const merged = {};
    (out.items || []).forEach((i) => { const c = normCat(i.category); merged[c] = (merged[c] || 0) + Math.max(1, parseInt(i.count, 10) || 1); });
    const items = Object.entries(merged).map(([category, count]) => ({ category, count }));
    await showResult({ location, items, source: 'AI', saved: true, severity: out.severity || 'low', summary: out.summary || '', suggestions: out.suggestions || [] });
  } catch (err) {
    $('resultBody').innerHTML = `<div class="notice">${esc(err.message.includes('Failed to fetch') ? 'Could not reach the AI service. Check your internet connection.' : err.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = 'Analyze Waste'; }
});

function showManual(location) {
  $('resultBody').innerHTML = `
    <h3>AI is not connected</h3>
    <div class="notice">No analysis has been run on this image. Connect an API key under "AI connection" to detect waste automatically, or tick what you can see below to record it manually.</div>
    <div class="loc-line">📍 ${esc(location)}</div>
    <div class="manual">${CATEGORIES.slice(0, 5).map((c) => `<label><input type="checkbox" value="${c}"> ${ICONS[c]} ${c}</label>`).join('')}</div>
    <button class="btn btn-primary" id="manualSave" type="button">Save manual record</button>`;
  $('manualSave').addEventListener('click', async () => {
    const items = [...$('resultBody').querySelectorAll('input:checked')].map((i) => ({ category: i.value, count: 1 }));
    if (!items.length) { toast('Tick at least one waste type.'); return; }
    await showResult({ location, items, source: 'Manual', severity: items.length > 2 ? 'medium' : 'low', summary: 'Waste types tagged manually by the user.', suggestions: [] });
  });
}

const SEVERITY = { none: 'No visible waste', low: 'Low', medium: 'Medium', high: 'High' };
const GENERIC_TIPS = {
  Plastic: 'Collect bottles and wrappers in the dry-waste bin; rinse bottles before recycling.',
  Paper: 'Gather clean paper and cardboard separately and keep it dry.',
  'Food waste': 'Move food waste to the wet or compost bin quickly to avoid pests and smell.',
  Metal: 'Collect cans and metal scraps with gloves and send to the metal recycling stream.',
  Glass: 'Pick up glass carefully with gloves and a dustpan; never mix it with general waste.',
  Other: 'Check that mixed waste is removed to the general waste bin.'
};
async function showResult(r) {
  const total = r.items.reduce((s, i) => s + i.count, 0);
  const tips = r.suggestions.length ? r.suggestions : r.items.map((i) => GENERIC_TIPS[i.category]);
  const extra = r.severity === 'high' ? ['Schedule a priority cleanup for this location today.'] : [];
  $('resultBody').innerHTML = `
    <h3>Detection result <span class="badge ${r.source === 'AI' ? 'on' : ''}">${r.source === 'AI' ? 'AI analysis' : 'Manual entry'}</span></h3>
    <div class="loc-line">📍 ${esc(r.location)}${r.source === 'AI' ? ` <span class="tag">Severity: ${SEVERITY[r.severity] || esc(r.severity)}</span>` : ''}</div>
    ${r.summary ? `<p style="margin-bottom:10px">${esc(r.summary)}</p>` : ''}
    ${total ? `<div class="chips">${r.items.map((i) => `<div class="chip">${ICONS[i.category]} ${i.category} <small>${r.source === 'AI' ? '~' : ''}${i.count}${r.source === 'AI' ? ' items' : ''}</small></div>`).join('')}</div>` : '<p>No visible waste was found in this image.</p>'}
    ${total ? `<h3>Cleaning and collection suggestions</h3><ul>${[...extra, ...tips].map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    <p style="font-size:.9rem">${total ? 'Saved to the dashboard history.' : 'Nothing was added to the dashboard.'} Counts are estimates from the image.</p>`;
  if (total) {
    try {
      if (!r.saved) { const thumb = await resizeImage(currentFile, 96, 0.6); await api('/api/detections', { method: 'POST', body: { location: r.location, items: r.items, thumb, ...pinData() } }); }
      await refreshData();
    } catch (e) { toast(e.message); }
  }
}

/* ---------- Dashboard ---------- */
let catChart, recChart;
function renderDashboard() {
  const history = DB.history, reports = DB.reports;
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  history.forEach((h) => h.items.forEach((i) => { counts[i.category] = (counts[i.category] || 0) + i.count; }));
  reports.forEach((r) => { counts[normCat(r.type)] += 1; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const rec = RECYCLABLE.reduce((s, c) => s + counts[c], 0), non = total - rec;
  const locs = new Set([...history, ...reports].map((x) => x.location.trim().toLowerCase()));
  $('sTotal').textContent = total; $('sRec').textContent = rec; $('sNon').textContent = non; $('sLoc').textContent = locs.size;
  $('sRecPct').textContent = total ? Math.round((rec / total) * 100) + '% of total' : '';
  $('sNonPct').textContent = total ? Math.round((non / total) * 100) + '% of total' : '';

  const font = { family: 'Figtree' };
  if (catChart) catChart.destroy(); if (recChart) recChart.destroy();
  catChart = new Chart($('catChart'), { type: 'doughnut',
    data: { labels: CATEGORIES, datasets: [{ data: CATEGORIES.map((c) => counts[c]), backgroundColor: CATEGORIES.map((c) => COLORS[c]), borderWidth: 3, borderColor: '#fff' }] },
    options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { font, usePointStyle: true } } } } });
  recChart = new Chart($('recChart'), { type: 'bar',
    data: { labels: ['Recyclable', 'Non-recyclable'], datasets: [{ data: [rec, non], backgroundColor: ['#2f9e5b', '#b9c4be'], borderRadius: 10, maxBarThickness: 90 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0, font } }, x: { ticks: { font } }, } } });

  $('historyBody').innerHTML = history.length ? history.slice(0, 10).map((h) => `
    <tr><td>${fmtDate(h.time)}</td>
    <td>${h.thumb ? `<img class="thumb" src="${h.thumb}" alt="">` : ''}${esc(h.location)}</td>
    <td>${h.items.map((i) => `${ICONS[i.category]} ${i.category} (${i.count})`).join(', ')}</td>
    <td><span class="tag">${esc(h.source)}</span></td></tr>`).join('')
    : '<tr><td colspan="4">No detections yet. Analyze an image to start the history.</td></tr>';
  if (typeof renderMap === 'function') renderMap();
  if (typeof renderAlerts === 'function') renderAlerts();
}
$('clearHistory').addEventListener('click', async () => {
  if (!requireLogin()) return;
  if (!confirm('Delete the detections you saved? Other users\' and sample entries stay.')) return;
  try { await api('/api/detections', { method: 'DELETE' }); await refreshData(); toast('Your detections were deleted.'); } catch (e) { toast(e.message); }
});

/* ---------- Reports ---------- */
function setErr(el, msg) { el.classList.toggle('invalid', !!msg); const p = el.parentElement.querySelector('.err'); if (p) p.textContent = msg; return !msg; }

$('reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!requireLogin()) return;
  const loc = $('rLocation'), type = $('rType'), desc = $('rDesc'), img = $('rImage');
  const file = img.files[0];
  const ok = [
    setErr(loc, loc.value.trim().length < 3 ? 'Enter a location name (at least 3 characters).' : ''),
    setErr(type, type.value ? '' : 'Select a waste type.'),
    setErr(desc, desc.value.trim().length < 10 ? 'Describe the problem in at least 10 characters.' : ''),
    setErr(img, file && imageProblem(file) ? imageProblem(file) : '')
  ].every(Boolean);
  if (!ok) return;
  const image = file ? await resizeImage(file, 400, 0.7) : '';
  try { await api('/api/reports', { method: 'POST', body: { location: loc.value.trim(), type: type.value, description: desc.value.trim(), image, ...pinData() } }); } catch (err) { toast(err.message); return; }
  e.target.reset(); $('reportOk').textContent = 'Report submitted. Thank you for helping keep the campus clean.';
  setTimeout(() => ($('reportOk').textContent = ''), 4000);
  await refreshData();
});

function renderReports() {
  const f = $('reportFilter').value;
  const list = DB.reports.filter((r) => f === 'all' || r.type === f);
  $('reportList').innerHTML = list.length ? list.map((r) => `
    <article class="report">
      ${r.image ? `<img src="${r.image}" alt="Photo for report at ${esc(r.location)}">` : `<div class="ph">${ICONS[r.type] || '🗑️'}</div>`}
      <div><h4>${esc(r.location)}</h4><p>${esc(r.description)}</p>
        <small><span class="tag">${esc(r.type)}</span> ${fmtDate(r.time)}${r.sample ? ' · sample' : ''}</small></div>
      <button class="del" data-id="${r.id}" aria-label="Delete report at ${esc(r.location)}">✕</button>
    </article>`).join('') : '<div class="card empty"><p>No reports for this filter yet. Submit one using the form.</p></div>';
}
$('reportFilter').addEventListener('change', renderReports);
$('reportList').addEventListener('click', async (e) => {
  const b = e.target.closest('.del'); if (!b) return;
  try { await api('/api/reports/' + b.dataset.id, { method: 'DELETE' }); await refreshData(); toast('Report deleted.'); } catch (err) { toast(err.message); }
});

/* ---------- Recycling guide ---------- */
const GUIDE = {
  Plastic: { icon: '🧴', intro: 'Plastic is light and durable, which is why it lasts so long in the environment. Most rigid plastics can be recycled if they are clean.',
    yes: ['Water and soft-drink bottles', 'Milk and detergent containers', 'Clean food tubs and lids', 'Plastic cups (rinsed)'],
    no: ['Greasy takeaway boxes', 'Chip and biscuit wrappers', 'Thin carry bags, unless a local drop-off accepts them', 'Plastic mixed with food'],
    how: ['Empty and rinse the container.', 'Crush bottles and put the cap back on.', 'Check the resin number: 1 (PET) and 2 (HDPE) are the most widely recycled.', 'Place in the dry-waste bin.'],
    fact: 'A PET bottle can be recycled into fibre for clothes, bags and new bottles.' },
  Paper: { icon: '📄', intro: 'Paper is among the easiest materials to recycle, as long as it stays dry and free from food.',
    yes: ['Notebooks and printouts', 'Newspapers and magazines', 'Cardboard boxes (flattened)', 'Envelopes'],
    no: ['Tissues and paper napkins', 'Greasy pizza boxes', 'Wet or heavily stained paper', 'Laminated or foil-coated paper'],
    how: ['Remove plastic covers, spirals and staples where practical.', 'Flatten boxes to save space.', 'Keep paper dry and separate from wet waste.', 'Drop it in the paper bin or hand it to the collection point.'],
    fact: 'Recycling one tonne of paper saves roughly 17 trees worth of fibre.' },
  Glass: { icon: '🍾', intro: 'Glass can be recycled again and again without losing quality, but broken glass is a safety risk for waste handlers.',
    yes: ['Bottles and jars', 'Clean glass containers'],
    no: ['Mirrors and window glass', 'Light bulbs and tube lights', 'Ceramic cups and plates', 'Heat-resistant cookware'],
    how: ['Empty and rinse the container.', 'Remove metal lids and recycle them separately.', 'Do not break the glass.', 'If it is broken, wrap it in paper and label it before disposal.'],
    fact: 'Glass can be recycled endlessly, and recycled glass melts at a lower temperature than raw material.' },
  Metal: { icon: '🥫', intro: 'Aluminium and steel are valuable and fully recyclable. Collecting them keeps them out of landfill and saves energy.',
    yes: ['Drink and food cans', 'Aluminium foil (clean, balled up)', 'Metal lids and caps', 'Small scrap such as wires and utensils'],
    no: ['Aerosols that are not empty', 'Batteries', 'Paint tins with wet paint', 'Electronics (send to e-waste collection)'],
    how: ['Empty the can and rinse it.', 'Crush aluminium cans to save space.', 'Handle sharp edges with care.', 'Put in the metal or dry-waste bin.'],
    fact: 'Recycling aluminium uses about 95% less energy than making it from ore.' },
  Organic: { icon: '🍌', intro: 'Food and garden waste is wet and heavy. Kept separate, it turns into compost instead of rotting with other waste.',
    yes: ['Fruit and vegetable peels', 'Leftover cooked food', 'Tea leaves and coffee grounds', 'Garden leaves and grass'],
    no: ['Plastic bags or wrappers', 'Meat and dairy in open compost pits', 'Diseased plants', 'Anything non-biodegradable'],
    how: ['Use a separate green or wet-waste bin.', 'Drain liquids before disposal.', 'Keep the bin covered and empty it daily.', 'Send to the campus compost pit or biogas unit if available.'],
    fact: 'Composting food waste cuts methane released from landfills and gives gardens free fertiliser.' }
};
function renderGuide(key) {
  const g = GUIDE[key];
  $('guidePanel').innerHTML = `
    <div class="intro"><h3>${g.icon} ${key}</h3><p>${g.intro}</p></div>
    <div class="yes"><h3>Put in the bin</h3><ul>${g.yes.map((x) => `<li>${x}</li>`).join('')}</ul></div>
    <div class="no"><h3>Keep out</h3><ul>${g.no.map((x) => `<li>${x}</li>`).join('')}</ul></div>
    <div><h3>How to prepare it</h3><ol style="padding-left:20px;color:var(--muted)">${g.how.map((x) => `<li style="margin-bottom:6px">${x}</li>`).join('')}</ol></div>
    <div class="fact" style="align-self:start">${g.fact}</div>`;
  $('guideTabs').querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.key === key));
}
$('guideTabs').innerHTML = Object.keys(GUIDE).map((k) => `<button class="tab" role="tab" data-key="${k}">${GUIDE[k].icon} ${k}</button>`).join('');
$('guideTabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) renderGuide(t.dataset.key); });

/* ---------- Contact ---------- */
$('contactForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const n = $('cName'), em = $('cEmail'), m = $('cMsg');
  const ok = [
    setErr(n, n.value.trim().length < 2 ? 'Enter your name.' : ''),
    setErr(em, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em.value.trim()) ? '' : 'Enter a valid email address.'),
    setErr(m, m.value.trim().length < 10 ? 'Message must be at least 10 characters.' : '')
  ].every(Boolean);
  if (!ok) return;
  try { await api('/api/contact', { method: 'POST', body: { name: n.value.trim(), email: em.value.trim(), message: m.value.trim() } }); }
  catch (err) { toast(err.message); return; }
  e.target.reset();
  $('contactOk').textContent = 'Message sent and saved. Thank you for getting in touch.';
});

/* ---------- Init ---------- */
document.querySelectorAll('input,textarea,select').forEach((el) => el.addEventListener('input', () => { el.classList.remove('invalid'); const p = el.parentElement.querySelector('.err'); if (p) p.textContent = ''; }));

/* ================= Login, map and CSV export ================= */
const CAMPUS = [17.3850, 78.4867]; /* change to your college's latitude and longitude */
var map, layer, pickMarker, picked = null, authMode = 'login';

/* --- login (server sessions: the account and password hash live in the database) --- */
const session = () => ME;
const userName = () => (ME && ME.name) || '';
function renderAuth() {
  $('authArea').innerHTML = ME ? `<span class="who">Hi, ${esc(ME.name)}</span><button class="btn btn-small btn-ghost" id="logoutBtn" type="button">Log out</button>`
    : '<button class="btn btn-small btn-primary" id="loginBtn" type="button">Log in</button>';
}
function openAuth(mode) {
  authMode = mode;
  const login = mode === 'login';
  $('authTitle').textContent = login ? 'Log in' : 'Create account';
  $('aNameField').hidden = login;
  $('authSubmit').textContent = login ? 'Log in' : 'Create account';
  $('authSwitch').textContent = login ? 'New here? Create an account' : 'Have an account? Log in';
  $('aPass').autocomplete = login ? 'current-password' : 'new-password';
  $('authErr').textContent = '';
  if (!$('authDialog').open) $('authDialog').showModal();
}
function requireLogin() {
  if (ME) return true;
  toast('Log in or create an account to continue.'); openAuth('login'); return false;
}
$('authArea').addEventListener('click', async (e) => {
  if (e.target.id === 'loginBtn') openAuth('login');
  if (e.target.id === 'logoutBtn') { await api('/api/logout', { method: 'POST', body: {} }); ME = null; renderAuth(); toast('Logged out.'); }
});
$('authSwitch').addEventListener('click', () => openAuth(authMode === 'login' ? 'register' : 'login'));
$('authCancel').addEventListener('click', () => $('authDialog').close());
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('aName').value.trim(), email = $('aEmail').value.trim().toLowerCase(), pw = $('aPass').value;
  const fail = (m) => { $('authErr').textContent = m; };
  if (authMode === 'register' && name.length < 2) return fail('Enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail('Enter a valid email address.');
  if (pw.length < 6) return fail('Password must be at least 6 characters.');
  try {
    const res = await api(authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body: { name, email, password: pw } });
    ME = res.user; $('authForm').reset(); $('authDialog').close(); renderAuth(); toast('Welcome, ' + ME.name + '.');
  } catch (err) { fail(err.message); }
});

/* --- map (Leaflet + OpenStreetMap tiles, needs internet) --- */
const pinData = () => (picked ? { lat: picked.lat, lng: picked.lng } : {});
function updatePinText() {
  document.querySelectorAll('.pinStatus').forEach((el) => {
    el.innerHTML = picked ? `📍 Pin set (${picked.lat.toFixed(4)}, ${picked.lng.toFixed(4)}). It will be saved with your next report or detection.`
      : 'No map pin set (optional). <a href="#reports" style="color:var(--leaf-dark);font-weight:600">Pick on map</a>';
  });
}
function setPick(lat, lng) {
  picked = { lat, lng };
  if (pickMarker) pickMarker.setLatLng([lat, lng]);
  else pickMarker = L.marker([lat, lng], { title: 'Selected pin' }).addTo(map);
  updatePinText();
}
function clearPick() { picked = null; if (pickMarker) { map.removeLayer(pickMarker); pickMarker = null; } updatePinText(); }
function renderMap() {
  if (!layer) return;
  layer.clearLayers();
  const pts = [];
  DB.reports.filter((r) => r.lat != null).forEach((r) => pts.push({ lat: r.lat, lng: r.lng, color: COLORS[normCat(r.type)], title: r.location, body: `${r.type} report: ${r.description}` }));
  DB.history.filter((h) => h.lat != null).forEach((h) => {
    const top = [...h.items].sort((a, b) => b.count - a.count)[0];
    pts.push({ lat: h.lat, lng: h.lng, color: COLORS[top ? top.category : 'Other'], title: h.location, body: 'Detected: ' + h.items.map((i) => `${i.category} (${i.count})`).join(', ') });
  });
  pts.forEach((p) => L.circleMarker([p.lat, p.lng], { radius: 10, color: '#fff', weight: 2, fillColor: p.color, fillOpacity: .95 })
    .bindPopup(`<strong>${esc(p.title)}</strong><br>${esc(p.body)}`).addTo(layer));
  if (pts.length && !renderMap.fitted) { map.fitBounds(pts.map((p) => [p.lat, p.lng]), { padding: [40, 40], maxZoom: 17 }); renderMap.fitted = true; }
}
function initMap() {
  if (typeof L === 'undefined') { $('mapEl').innerHTML = '<div class="notice" style="margin:20px">The map library could not load. Check your internet connection and reload.</div>'; return; }
  map = L.map('mapEl').setView(CAMPUS, 16);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('click', (e) => setPick(e.latlng.lat, e.latlng.lng));
  renderMap();
}
$('gpsBtn').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('This browser does not support location.');
  navigator.geolocation.getCurrentPosition((p) => { if (!map) return; setPick(p.coords.latitude, p.coords.longitude); map.setView([p.coords.latitude, p.coords.longitude], 17); },
    () => toast('Could not get your location. Allow location access or click the map instead.'), { enableHighAccuracy: true, timeout: 10000 });
});
$('clearPin').addEventListener('click', clearPick);

/* --- CSV export --- */
function csvCell(v) {
  v = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(v)) v = "'" + v; /* stops spreadsheet formula injection */
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function downloadCsv(name, rows) {
  const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name + '-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('exportReports').addEventListener('click', () => {
  const list = DB.reports;
  if (!list.length) return toast('No reports to export.');
  downloadCsv('waste-reports', [['Date', 'Location', 'Waste type', 'Description', 'Latitude', 'Longitude', 'Reported by', 'Sample data'],
    ...list.map((r) => [new Date(r.time).toISOString(), r.location, r.type, r.description, r.lat, r.lng, r.by, r.sample ? 'yes' : 'no'])]);
});
$('exportHistory').addEventListener('click', () => {
  const list = DB.history;
  if (!list.length) return toast('No detection history to export.');
  downloadCsv('waste-detections', [['Date', 'Location', 'Latitude', 'Longitude', 'Source', ...CATEGORIES, 'Total items', 'Saved by', 'Sample data'],
    ...list.map((h) => { const c = Object.fromEntries(h.items.map((i) => [i.category, i.count]));
      return [new Date(h.time).toISOString(), h.location, h.lat, h.lng, h.source, ...CATEGORIES.map((k) => c[k] || 0), h.items.reduce((s, i) => s + i.count, 0), h.by, h.sample ? 'yes' : 'no']; })]);
});

/* --- upload / camera tabs --- */
$('seg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $('seg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  if (b.dataset.mode === 'camera') input.setAttribute('capture', 'environment'); else input.removeAttribute('capture');
  input.click();
});

/* --- dashboard alerts and hotspots --- */
const SEV = { 'Food waste': ['#c8402f', 'High'], Glass: ['#c8402f', 'High'], Plastic: ['#e0a21b', 'Medium'], Metal: ['#e0a21b', 'Medium'], Mixed: ['#e0a21b', 'Medium'], Paper: ['#2f9e5b', 'Low'] };
function renderAlerts() {
  const reports = DB.reports;
  $('alertList').innerHTML = reports.length ? reports.slice(0, 5).map((r) => { const s = SEV[r.type] || ['#e0a21b', 'Medium']; return `
    <div class="alert" style="--c:${s[0]}"><div class="between" style="margin:0"><strong>${esc(r.location)}</strong><span class="tag">${s[1]}</span></div>
    <small>${esc(r.type)} · ${fmtDate(r.time)}</small><p>${esc(r.description.slice(0, 90))}${r.description.length > 90 ? '...' : ''}</p></div>`; }).join('')
    : '<p>No reports yet. Reports you submit appear here as alerts.</p>';
  const tally = {};
  DB.history.forEach((h) => { tally[h.location] = (tally[h.location] || 0) + h.items.reduce((s, i) => s + i.count, 0); });
  reports.forEach((r) => { tally[r.location] = (tally[r.location] || 0) + 1; });
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5), max = top.length ? top[0][1] : 1;
  $('hotList').innerHTML = top.length ? top.map(([n, c]) => `<div class="hot"><span>${esc(n)}</span><strong>${c}</strong><div class="bar"><i style="width:${Math.round((c / max) * 100)}%"></i></div></div>`).join('') : '<p>No locations recorded yet.</p>';
}

/* --- start-up --- */
async function init() {
  renderGuide('Plastic'); renderAuth(); updatePinText(); initMap(); route();
  try { const st = await api('/api/status'); AI_ON = st.ai; ME = st.user; refreshApiBadge(); renderAuth(); await refreshData(); }
  catch { refreshApiBadge(); toast('Cannot reach the server. Start it with: python app.py'); }
}
init();