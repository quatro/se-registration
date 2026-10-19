/* SE Registration — browser client.
   The server owns the numbers (seat math lives in src/lib/capacity.ts) and
   pushes a change event over SSE; this file renders /api/state and sends
   admin actions back. */
'use strict';

const STATUSES = ['Registered', 'Expected', 'Need to contact', 'Waitlist', 'Not returning', 'Withdrawn'];
const S = { st: null, me: null, tab: 'overview', live: false, regs: null, log: null, pendingRender: false, sel: new Set() };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dotCls = (s) => ({ Registered: 'Registered', Expected: 'Expected', 'Need to contact': 'Need', Waitlist: 'Waitlist', 'Not returning': 'Not-returning', Withdrawn: 'Withdrawn' }[s] || '');
const isAdmin = () => !!S.st?.canWrite;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toast(m, err) { const t = $('toast'); t.textContent = m; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), err ? 4500 : 2400); }

async function call(method, url, body) {
  // Every mutation goes out as JSON (even a bodiless DELETE) — the server's CSRF guard requires it.
  if (body === undefined && method !== 'GET') body = {};
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    if (r.status === 401 && data?.error === 'login_required') { location.href = '/admin'; }
    throw new Error(data?.error || `Request failed (${r.status})`);
  }
  return data;
}
async function act(method, url, body, okMsg) {
  try { const d = await call(method, url, body); if (okMsg || d?.message) toast(d?.message || okMsg); return d; }
  catch (e) { toast(e.message, true); return null; }
}

const div = (id) => S.st.divisions.find((d) => d.id === id);
const player = (id) => S.st.players?.find((p) => p.id === id);
const divOpts = (v, blank = '— No division —') => `<option value="">${esc(blank)}</option>` + S.st.divisions.map((d) => `<option value="${esc(d.id)}" ${d.id === v ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
const ageRange = (d) => (d.min_age == null && d.max_age == null ? '' : d.min_age === d.max_age ? `${d.min_age}` : `${d.min_age ?? '?'}–${d.max_age ?? '?'}`);
const fitsAge = (d, age) => age == null || !d || ((d.min_age == null || age >= d.min_age) && (d.max_age == null || age <= d.max_age));

/* ---------- render ---------- */
function render() {
  if (!S.st) return;
  const st = S.st;
  document.title = `${st.settings.season || ''} SE Registration`.trim();
  $('season').textContent = `SE Baseball · ${st.settings.season || ''}`;
  document.querySelectorAll('[data-admin]').forEach((el) => (el.hidden = !isAdmin()));
  renderWho();
  if (S.tab === 'overview') renderOverview();
  // Admin tabs hold inputs; don't rebuild under someone's cursor. Re-render on blur instead.
  const ae = document.activeElement;
  const typing = ae && ae.closest && ae.closest('section') && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && ae.type !== 'checkbox' && ae.type !== 'file';
  if (typing && ['players', 'divisions', 'regs'].includes(S.tab)) { S.pendingRender = true; return; }
  if (S.tab === 'players') renderPlayers();
  if (S.tab === 'divisions') renderDivisions();
  if (S.tab === 'regs') renderRegs();
  if (S.tab === 'log') renderLog();
}
document.addEventListener('focusout', () => setTimeout(() => { if (S.pendingRender && !document.activeElement?.closest?.('section')) { S.pendingRender = false; render(); } }, 0));

function renderWho() {
  $('whoami').innerHTML = S.me?.admin
    ? `Signed in as <b>${esc(S.me.admin)}</b> · <button id="logout">Log out</button>`
    : `<a href="/admin">Admin login</a>`;
  const lo = $('logout');
  if (lo) lo.onclick = async () => { await act('POST', '/api/logout', {}); location.href = '/'; };
  const l = S.st.links || {};
  $('tools').innerHTML = `<span class="chip ${S.live ? 'live' : 'off'}">${S.live ? 'Live' : 'Reconnecting'}</span>${l.draftBoard ? `<a href="${esc(l.draftBoard)}">Majors draft board ↗</a>` : ''}`;
}

/* ---------- seats overview ---------- */
const STATE = {
  open: ['good', 'Open'], closing: ['meh', 'Closing soon'], full: ['bad', 'Full'], over: ['bad', 'Over capacity'],
  closed: ['', 'Registration closed'], unset: ['', 'No teams set'],
};
function renderOverview() {
  const st = S.st, ds = st.divisions;
  const act = ds.filter((d) => d.seats.state === 'full' || d.seats.state === 'over');
  const soon = ds.filter((d) => d.seats.state === 'closing');
  const closed = ds.filter((d) => d.seats.state === 'closed');
  const h = $('headline');
  if (!ds.length || ds.every((d) => d.seats.state === 'unset')) {
    h.className = 'headline';
    h.innerHTML = `<div class="big">No divisions set up yet</div><div class="meta">${isAdmin() ? 'Add divisions, team counts and last season\'s rosters under <b>Divisions</b>.' : 'Seat counts will appear here once the league sets up its divisions.'}</div>`;
  } else if (act.length) {
    h.className = 'headline act';
    h.innerHTML = `<div class="big">Close registration: ${act.map((d) => esc(d.name)).join(', ')}</div>
      <div class="meta">${act.map((d) => d.seats.open < 0 ? `${esc(d.name)} is ${plural(-d.seats.open, 'player')} over` : `${esc(d.name)} is full`).join(' · ')} — counting seats held for returners who haven't registered yet.${soon.length ? ` Closing soon: ${soon.map((d) => `${esc(d.name)} (${d.seats.open} left)`).join(', ')}.` : ''}</div>`;
  } else if (soon.length) {
    h.className = 'headline soon';
    h.innerHTML = `<div class="big">Closing soon: ${soon.map((d) => `${esc(d.name)} — ${plural(d.seats.open, 'seat')} left`).join(', ')}</div><div class="meta">Every other division has room.</div>`;
  } else {
    h.className = 'headline';
    h.innerHTML = `<div class="big">Registration open — ${plural(st.total.open, 'seat')} left</div><div class="meta">No division is close to full.${closed.length ? ` Closed: ${closed.map((d) => esc(d.name)).join(', ')}.` : ''}</div>`;
  }
  // Held seats are a forecast, not sign-ups; say so loudly until registrations arrive.
  if (st.total.held) {
    h.insertAdjacentHTML('beforeend', st.total.registered
      ? `<div class="meta"><b>${plural(st.total.held, 'seat')}</b> held for expected returners are placeholders until those kids register or drop out.</div>`
      : `<div class="meta"><b>No one has registered yet.</b> The ${plural(st.total.held, 'seat')} held for expected returners are placeholders until those kids register or drop out.</div>`);
  }

  $('divs').innerHTML = ds.map((d) => {
    const s = d.seats, [cls, label] = STATE[s.state];
    const base = Math.max(s.capacity, s.projected, 1);
    const w = (n) => `${(100 * n / base).toFixed(2)}%`;
    const flags = [];
    if (s.atRisk) flags.push(`<span class="chip meh" title="Returners marked Need to contact still hold a seat">${s.atRisk} need contact · best case ${s.bestCaseOpen} open</span>`);
    if (s.coachGap) flags.push(`<span class="chip bad">${plural(s.coachGap, 'team')} without a coach</span>`);
    if (s.capacity && s.teamsNeeded > d.teams) flags.push(`<span class="chip bad">Projected ${s.projected} kids = ${s.teamsNeeded} teams</span>`);
    if (s.waitlist) flags.push(`<span class="chip">${s.waitlist} waitlisted</span>`);
    if (d.ageMismatches) flags.push(`<span class="chip meh">${plural(d.ageMismatches, 'kid')} outside ${esc(ageRange(d))}</span>`);
    return `<article class="div ${s.state}">
      <div class="top"><div><h3>${esc(d.name)}</h3><div class="sub">${d.teams} teams × ${d.roster_size}${ageRange(d) ? ` · ${d.min_age === d.max_age ? 'age' : 'ages'} ${esc(ageRange(d))}` : ''}</div>
        <span class="chip ${cls}" style="margin-top:6px">${label}</span></div>
        <div class="open"><b>${s.capacity ? (s.open < 0 ? `+${-s.open}` : s.open) : '—'}</b><span>${s.open < 0 ? 'over' : 'seats open'}</span></div></div>
      <div class="bar ${s.open < 0 ? 'over' : ''}" role="img" aria-label="${s.registered} registered, ${s.expected} returners expected, ${s.atRisk} need contact, of ${s.capacity} seats">
        <i class="reg" style="width:${w(s.registered)}"></i><i class="exp" style="width:${w(s.expected)}"></i><i class="risk" style="width:${w(s.atRisk)}"></i></div>
      <div class="nums">
        <div><b>${s.capacity}</b><span>Seats</span></div>
        <div><b>${s.registered}</b><span>Registered${s.registered ? ` (${s.returnersRegistered} ret · ${s.newRegistered} new)` : ''}</span></div>
        <div title="Placeholders: expected returners who have not registered yet"><b>${s.held}</b><span>Held · expected returners</span></div>
      </div>
      ${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}
    </article>`;
  }).join('');
  const t = st.total;
  $('totals').innerHTML = `<span>League: <b>${t.capacity}</b> seats</span><span><b>${t.registered}</b> registered</span><span><b>${t.held}</b> held for expected returners</span><span><b>${t.open}</b> open</span>${st.unplaced && isAdmin() ? `<span class="warn-text">${st.unplaced} not in a division</span>` : ''}`;
}

/* ---------- dialogs ---------- */
function openDialog(html, bind) {
  const d = $('dlg'); d.innerHTML = html; bind?.(d); d.showModal();
  d.querySelectorAll('[data-close]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); d.close(); }));
}
function playerForm() {
  openDialog(`<form id="pf"><h2>Add player</h2>
    <div class="row"><label for="fName">Name</label><input type="text" id="fName" required style="flex:1"></div>
    <div class="row"><label for="fDob">Birthdate</label><input type="date" id="fDob" style="width:auto"></div>
    <div class="row"><label for="fDiv">Division</label><select id="fDiv" style="width:auto">${divOpts('')}</select></div>
    <div class="row"><label for="fRet">Returner?</label><select id="fRet" style="width:auto"><option value="1">Returner — holds a seat as Expected</option><option value="0">New — Registered</option></select></div>
    <p class="err-text" id="fErr"></p>
    <div class="row"><button class="btn primary" type="submit">Add</button><span class="spacer"></span><button class="btn" data-close>Cancel</button></div></form>`, (d) => {
    d.querySelector('#pf').onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: d.querySelector('#fName').value, birthdate: d.querySelector('#fDob').value || null, divisionId: d.querySelector('#fDiv').value || null, returner: d.querySelector('#fRet').value === '1' };
      try { await call('POST', '/api/admin/players', body); toast('Player added'); d.close(); }
      catch (err) { d.querySelector('#fErr').textContent = err.message; }
    };
  });
}
async function showHistory(id) {
  const p = player(id);
  const h = await act('GET', `/api/admin/players/${id}/history`); if (!h) return;
  openDialog(`<div class="dlg"><h2>${esc(p?.name)}</h2>
    <p class="sub">${esc(p?.status)}${p?.status_locked ? ' (locked)' : ''} · ${esc(div(p?.division_id)?.name || 'no division')}${p?.division_locked ? ' (pinned by an admin)' : ''}${p?.se_program ? ` · SE program “${esc(p.se_program)}”` : ''}${p?.prior_division ? ` · last season ${esc(p.prior_division)}` : ''}</p>
    <h3>Registrations</h3>${h.registrations.length ? `<table class="kt">${h.registrations.map((r) => `<tr><td>${esc(r.received_at)}</td><td>${esc(r.source)}</td><td>${esc(r.program || '')}</td><td>${esc(r.outcome)}</td><td>${esc(r.note)}</td></tr>`).join('')}</table>` : '<p class="note">None yet.</p>'}
    <h3>History</h3>${h.audit.length ? `<table class="kt">${h.audit.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace(/_/g, ' '))}</td><td class="mono">${esc(a.detail)}</td></tr>`).join('')}</table>` : '<p class="note">No changes recorded.</p>'}
    <div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`);
}

/* ---------- players tab ---------- */
function filteredPlayers() {
  const st = S.st, q = $('plSearch').value.trim().toLowerCase(), dv = $('plDiv').value, sv = $('plStatus').value, kv = $('plKind').value, mis = $('plMismatch').checked;
  const order = Object.fromEntries(st.divisions.map((d, i) => [d.id, i]));
  return st.players.filter((p) => (!q || p.name.toLowerCase().includes(q) || (p.notes || '').toLowerCase().includes(q) || (p.prior_division || '').toLowerCase().includes(q))
    && (!dv || (dv === '-' ? !p.division_id : p.division_id === dv)) && (!sv || p.status === sv) && (kv === '' || String(p.returner) === kv)
    && (!mis || (p.division_id && !fitsAge(div(p.division_id), p.age))))
    .sort((a, b) => (order[a.division_id] ?? 999) - (order[b.division_id] ?? 999) || STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status) || a.name.localeCompare(b.name));
}
function renderPlayers() {
  const st = S.st;
  const dSel = $('plDiv'), sSel = $('plStatus'), dv = dSel.value, sv = sSel.value;
  dSel.innerHTML = '<option value="">All divisions</option><option value="-">Not in a division</option>' + st.divisions.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
  sSel.innerHTML = '<option value="">All statuses</option>' + STATUSES.map((s) => `<option>${s}</option>`).join('');
  dSel.value = dv; sSel.value = sv;
  const list = filteredPlayers();
  for (const id of [...S.sel]) if (!player(id)) S.sel.delete(id);
  const allSel = list.length && list.every((p) => S.sel.has(p.id));
  $('plTable').innerHTML = `<tr><th><input type="checkbox" id="selAll" ${allSel ? 'checked' : ''} aria-label="Select all shown"></th><th>Player</th><th class="num">Age</th><th>Birthdate</th><th>Division</th><th>Type</th><th>Last season</th><th>Status</th><th title="Lock status against SportsEngine updates">Lock</th><th>SE program</th><th>Notes</th><th></th></tr>`
    + (list.length ? list.map((p) => {
      const d = div(p.division_id), bad = d && !fitsAge(d, p.age);
      return `<tr data-p="${esc(p.id)}" class="${['Not returning', 'Withdrawn'].includes(p.status) ? 'dim' : ''} ${S.sel.has(p.id) ? 'sel' : ''}">
        <td><input type="checkbox" data-sel ${S.sel.has(p.id) ? 'checked' : ''} aria-label="Select ${esc(p.name)}"></td>
        <td><input type="text" data-f="name" value="${esc(p.name)}" style="min-width:150px" aria-label="Name"></td>
        <td class="num ${bad ? 'warn-text' : ''}" title="${bad ? `Outside ${esc(d.name)} ages ${esc(ageRange(d))}` : 'League age'}">${esc(p.age ?? '')}</td>
        <td><input type="date" data-f="birthdate" value="${esc(p.birthdate || '')}" aria-label="Birthdate"></td>
        <td><span class="dv"><select data-f="divisionId" aria-label="Division">${divOpts(p.division_id)}</select>${p.division_locked ? `<button class="mini pin" data-unpin title="Placed by an admin; SportsEngine won't move them. Click to let their SE program decide again.">Pinned ✕</button>` : ''}</span></td>
        <td><select data-f="returner" aria-label="Returner or new"><option value="1" ${p.returner ? 'selected' : ''}>Returner</option><option value="0" ${p.returner ? '' : 'selected'}>New</option></select></td>
        <td class="sub">${esc(p.prior_division)}</td>
        <td><span class="kp"><i class="dot ${dotCls(p.status)}"></i><select data-f="status" aria-label="Status">${STATUSES.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}</select></span></td>
        <td><input type="checkbox" data-f="locked" ${p.status_locked ? 'checked' : ''} aria-label="Lock status"></td>
        <td class="sub">${esc(p.se_program || '')}</td>
        <td><input type="text" data-f="notes" value="${esc(p.notes)}" style="min-width:160px" aria-label="Notes"></td>
        <td style="white-space:nowrap"><button class="mini" data-hist>History</button> <button class="mini" data-del>Delete</button></td></tr>`;
    }).join('') : '<tr><td colspan="12" class="note">No players match.</td></tr>');
  renderMoveBar();
}
function renderMoveBar() {
  $('moveBar').hidden = !S.sel.size;
  $('moveCount').textContent = `${plural(S.sel.size, 'player')} selected`;
  const v = $('moveTo').value;
  $('moveTo').innerHTML = divOpts(v, 'Choose a division');
}
['plSearch', 'plDiv', 'plStatus', 'plKind', 'plMismatch'].forEach((id) => ($(id)[id === 'plSearch' ? 'oninput' : 'onchange'] = () => renderPlayers()));
$('addPlayer').onclick = () => playerForm();
$('plTable').onchange = async (e) => {
  if (e.target.id === 'selAll') { filteredPlayers().forEach((p) => (e.target.checked ? S.sel.add(p.id) : S.sel.delete(p.id))); return renderPlayers(); }
  const tr = e.target.closest('[data-p]'); if (!tr) return;
  const id = tr.dataset.p;
  if (e.target.matches('[data-sel]')) { e.target.checked ? S.sel.add(id) : S.sel.delete(id); tr.classList.toggle('sel', e.target.checked); return renderMoveBar(); }
  const f = e.target.dataset.f; if (!f) return;
  let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  if (f === 'returner') v = v === '1';
  if (f === 'divisionId' || f === 'birthdate') v = v || null;
  const msg = f === 'divisionId' ? `Moved to ${div(v)?.name || 'no division'}` : 'Saved';
  if (!(await act('PATCH', `/api/admin/players/${id}`, { [f]: v }, msg))) render();
};
$('plTable').onclick = async (e) => {
  const tr = e.target.closest('[data-p]'); if (!tr) return;
  const id = tr.dataset.p;
  if (e.target.matches('[data-hist]')) return showHistory(id);
  if (e.target.matches('[data-unpin]')) return act('PATCH', `/api/admin/players/${id}`, { divisionLocked: false }, 'Unpinned — their SE program decides again');
  const dl = e.target.closest('[data-del]');
  if (dl) { if (dl.dataset.armed) act('DELETE', `/api/admin/players/${id}`, undefined, 'Player deleted'); else { dl.dataset.armed = '1'; dl.textContent = 'Delete?'; } }
};
$('moveGo').onclick = async () => {
  const to = $('moveTo').value;
  if (!to) return toast('Choose a division to move them to', true);
  if (await act('POST', '/api/admin/players/move', { ids: [...S.sel], divisionId: to, reason: $('moveReason').value.trim() || undefined })) {
    S.sel.clear(); $('moveReason').value = ''; renderPlayers();
  }
};
$('moveClear').onclick = () => { S.sel.clear(); renderPlayers(); };

/* ---------- divisions tab ---------- */
function renderDivisions() {
  const st = S.st;
  const num = (f, v, w = 56) => `<input type="number" data-f="${f}" value="${esc(v ?? '')}" min="0" style="width:${w}px" aria-label="${f}">`;
  $('divTable').innerHTML = `<tr><th></th><th>Division</th><th class="num">Teams</th><th class="num">Roster</th><th class="num">Seats</th><th class="num">Coaches</th><th>Ages</th><th>SE program words</th><th title="Relay registrations to the Majors draft board">Draft board</th><th title="Mark registration closed">Closed</th><th></th></tr>`
    + (st.divisions.length ? st.divisions.map((d, i) => `<tr data-d="${esc(d.id)}">
      <td style="white-space:nowrap"><button class="mini" data-up ${i ? '' : 'disabled'} aria-label="Move up">↑</button><button class="mini" data-down ${i < st.divisions.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button></td>
      <td><input type="text" data-f="name" value="${esc(d.name)}" style="min-width:120px" aria-label="Name"></td>
      <td class="num">${num('teams', d.teams)}</td><td class="num">${num('roster_size', d.roster_size)}</td>
      <td class="num"><b>${d.seats.capacity}</b></td>
      <td class="num">${num('coaches', d.coaches)}</td>
      <td style="white-space:nowrap">${num('min_age', d.min_age, 50)}–${num('max_age', d.max_age, 50)}</td>
      <td><input type="text" data-f="se_match" value="${esc(d.se_match)}" placeholder="${esc(d.name.toLowerCase())}" style="min-width:160px" aria-label="SE program words"></td>
      <td><input type="checkbox" data-f="forward" ${d.forward ? 'checked' : ''} aria-label="Forward to draft board"></td>
      <td><input type="checkbox" data-f="closed" ${d.closed ? 'checked' : ''} aria-label="Registration closed"></td>
      <td><button class="mini" data-del>Delete</button></td></tr>`).join('')
      : '<tr><td colspan="11" class="note">No divisions yet. Add one for each level (e.g. T-Ball, Coach Pitch, Minors, Majors).</td></tr>');
  const s = st.settings;
  $('seasonIn').value = s.season; $('regYear').value = s.registrationYear; $('ageCutoff').value = s.ageCutoff; $('warnAt').value = s.warnAt;
  const v = $('retDefault').value; $('retDefault').innerHTML = divOpts(v, 'Leave unplaced'); $('retDefault').value = v;
}
function divBody(tr) {
  const val = (f) => tr.querySelector(`[data-f="${f}"]`);
  const n = (f) => (val(f).value === '' ? null : parseInt(val(f).value, 10));
  return { name: val('name').value, teams: n('teams') ?? 0, roster_size: n('roster_size') ?? 12, coaches: n('coaches'), min_age: n('min_age'), max_age: n('max_age'),
    se_match: val('se_match').value, forward: val('forward').checked, closed: val('closed').checked };
}
$('divTable').onchange = async (e) => {
  const tr = e.target.closest('[data-d]'); if (!tr || !e.target.dataset.f) return;
  if (!(await act('PATCH', `/api/admin/divisions/${tr.dataset.d}`, divBody(tr), 'Saved'))) render();
};
$('divTable').onclick = async (e) => {
  const tr = e.target.closest('[data-d]'); if (!tr) return;
  const ids = S.st.divisions.map((d) => d.id), i = ids.indexOf(tr.dataset.d);
  if (e.target.matches('[data-up],[data-down]')) {
    const j = e.target.matches('[data-up]') ? i - 1 : i + 1;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    return act('PUT', '/api/admin/divisions/order', { order: ids });
  }
  const dl = e.target.closest('[data-del]');
  if (dl) {
    if (dl.dataset.armed) act('DELETE', `/api/admin/divisions/${tr.dataset.d}`, undefined, 'Division deleted — its players are now unplaced');
    else { dl.dataset.armed = '1'; dl.textContent = 'Delete?'; }
  }
};
$('addDiv').onclick = () => openDialog(`<form id="df"><h2>Add division</h2>
  <div class="row"><label for="dName">Name</label><input type="text" id="dName" required style="flex:1" placeholder="e.g. Minors"></div>
  <div class="row"><label for="dTeams">Teams</label><input type="number" id="dTeams" min="0" value="0" style="width:80px"><label for="dRoster" style="min-width:0">× roster</label><input type="number" id="dRoster" min="1" value="12" style="width:80px"></div>
  <div class="row"><label for="dMin">League ages</label><input type="number" id="dMin" min="0" style="width:70px" aria-label="Youngest">–<input type="number" id="dMax" min="0" style="width:70px" aria-label="Oldest"></div>
  <div class="row"><label for="dMatch">SE program words</label><input type="text" id="dMatch" style="flex:1" placeholder="defaults to the name"></div>
  <p class="err-text" id="dErr"></p>
  <div class="row"><button class="btn primary" type="submit">Add</button><span class="spacer"></span><button class="btn" data-close>Cancel</button></div></form>`, (d) => {
  const n = (id) => { const v = d.querySelector(id).value; return v === '' ? null : parseInt(v, 10); };
  d.querySelector('#df').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await call('POST', '/api/admin/divisions', { name: d.querySelector('#dName').value, teams: n('#dTeams') ?? 0, roster_size: n('#dRoster') ?? 12, min_age: n('#dMin'), max_age: n('#dMax'), se_match: d.querySelector('#dMatch').value });
      toast('Division added'); d.close();
    } catch (err) { d.querySelector('#dErr').textContent = err.message; }
  };
});
$('retImport').onclick = async () => {
  const text = $('retBox').value.trim(); if (!text) return toast('Paste last season\'s rosters first', true);
  const r = await act('POST', '/api/admin/returners/import', { text, divisionId: $('retDefault').value || null });
  if (r) {
    const parts = Object.entries(r.byDivision).map(([k, v]) => `${v} ${k}`);
    toast(`Added ${r.added} returners${parts.length ? ` (${parts.join(', ')})` : ''}${r.duplicates ? ` · ${r.duplicates} already here` : ''}${r.agedOut ? ` · ${r.agedOut} aged out` : ''}${r.unplaced ? ` · ${r.unplaced} unplaced` : ''}`);
    $('retBox').value = '';
  }
};
const patchSettings = (b) => act('PATCH', '/api/admin/settings', b, 'Saved');
$('seasonIn').onchange = (e) => patchSettings({ season: e.target.value.trim() });
$('regYear').onchange = (e) => patchSettings({ registrationYear: parseInt(e.target.value, 10) });
$('ageCutoff').onchange = (e) => patchSettings({ ageCutoff: e.target.value.trim() });
$('warnAt').onchange = (e) => patchSettings({ warnAt: parseInt(e.target.value, 10) || 0 });

/* ---------- registrations tab ---------- */
const OUTCOME_CHIP = { placed: 'good', returner: 'good', withdrawn: 'meh', no_division: 'bad', ambiguous: 'bad', error: 'bad', pending: 'meh', wrong_year: '', ignored: '' };
const LABELS = { placed: 'New player', returner: 'Returner', withdrawn: 'Withdrawn', no_division: 'No division', ambiguous: 'Ambiguous', error: 'Error', pending: 'Pending', wrong_year: 'Other years', ignored: 'Ignored' };
async function loadRegs() {
  const d = await call('GET', `/api/admin/registrations?filter=${encodeURIComponent($('regFilter').value)}`).catch((e) => { toast(e.message, true); return null; });
  if (!d) return;
  S.regs = d;
  const open = ['no_division', 'ambiguous', 'error', 'pending'].reduce((a, k) => a + (d.counts[k] || 0), 0);
  $('regBadge').hidden = !open; $('regBadge').textContent = open;
  if (S.tab === 'regs') renderRegs();
}
function renderRegs() {
  const d = S.regs; if (!d) return;
  const w = d.webhook;
  $('whInfo').innerHTML = (w.configured
    ? `<p>Give SportsEngine this endpoint (POST, JSON):</p><code>${esc(w.url)}</code>
       <p class="note">${w.signed ? `Signatures are <b>required</b> (HMAC-SHA256 in <code>${esc(w.signatureHeader)}</code>).` : 'No signing secret set yet: deliveries are accepted on the URL token alone and marked unverified. Set <code>SPORTSENGINE_WEBHOOK_SECRET</code> once SportsEngine issues one.'}</p>
       <p class="note">Only <b>${esc(S.st.settings.registrationYear)}</b> registrations take a seat. Every delivery is kept, so a mapping fix can be re-run.</p>`
    : `<p>Not switched on yet. Set <code>SPORTSENGINE_WEBHOOK_TOKEN</code> in <code>.env</code> and restart; the URL to give SportsEngine will appear here.</p><p class="note">Meanwhile, import the registration report CSV below.</p>`)
    + `<p class="note">${d.relayConfigured ? 'Registrations placed in a division with <b>Draft board</b> ticked are relayed to the Majors draft board, so SportsEngine only needs this one URL.' : 'Draft board relay is off (<code>DRAFT_BOARD_WEBHOOK_URL</code> not set).'}</p>`;
  $('regCounts').innerHTML = Object.entries(LABELS).filter(([k]) => d.counts[k]).map(([k, l]) => `<span class="chip ${OUTCOME_CHIP[k]}">${l} ${d.counts[k]}</span>`).join('')
    + (d.counts.relay ? `<span class="chip bad">Relay failed ${d.counts.relay}</span>` : '') || '<span class="note">No registrations received yet.</span>';
  const playerOpts = (S.st.players || []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((p) => `<option value="p:${esc(p.id)}">${esc(p.name)}${p.age != null ? ` (${p.age})` : ''} · ${esc(div(p.division_id)?.name || 'no division')}</option>`).join('');
  const divChoices = S.st.divisions.map((x) => `<option value="d:${esc(x.id)}">${esc(x.name)}</option>`).join('');
  $('regTable').innerHTML = `<tr><th>Received (UTC)</th><th>Source</th><th>Participant</th><th>DOB</th><th>Program</th><th>Outcome</th><th>Division</th><th>Note</th><th></th></tr>`
    + (d.rows.length ? d.rows.map((r) => {
      const needs = ['no_division', 'ambiguous', 'error', 'pending'].includes(r.outcome);
      const relay = r.forwarded ? (r.forwarded === 'ok' ? '<span class="tag">→ draft board</span>' : `<span class="tag warn-text" title="${esc(r.forwarded)}">relay failed</span>`) : '';
      return `<tr data-r="${r.id}"><td class="sub">${esc(r.received_at)}</td><td>${esc(r.source)}${r.source === 'webhook' && !r.verified ? ' <span class="tag">unverified</span>' : ''}</td>
        <td><b>${esc([r.first_name, r.last_name].filter(Boolean).join(' ') || '—')}</b>${r.event_type ? `<div class="sub">${esc(r.event_type)}</div>` : ''}</td>
        <td>${esc(r.birthdate || '')}</td><td>${esc(r.program || '')}</td>
        <td><span class="chip ${OUTCOME_CHIP[r.outcome] ?? ''}">${esc(LABELS[r.outcome] || r.outcome)}</span></td>
        <td>${esc(r.division_name || '')} ${relay}</td><td class="sub">${esc(r.note)}</td>
        <td style="white-space:nowrap">${needs ? `<select data-place aria-label="Place" style="width:180px"><option value="">Place…</option><optgroup label="New player in division">${divChoices}</optgroup><optgroup label="Existing player">${playerOpts}</optgroup></select> <button class="mini" data-ignore>Ignore</button> ` : ''}${r.forwarded && r.forwarded !== 'ok' ? '<button class="mini" data-relay>Resend</button> ' : ''}<button class="mini" data-rerun>Re-run</button> <button class="mini" data-raw>Raw</button></td></tr>`;
    }).join('') : '<tr><td colspan="9" class="note">Nothing here.</td></tr>');
  $('mDiv').innerHTML = `<option value="">Program (from division)</option>` + S.st.divisions.map((x) => `<option value="${esc(x.name)}">${esc(x.name)}</option>`).join('');
}
$('regFilter').onchange = loadRegs;
$('regReprocess').onclick = async () => { const t = await act('POST', '/api/admin/registrations/reprocess-open', {}); if (t) { toast(Object.entries(t).map(([k, v]) => `${v} ${LABELS[k] || k}`).join(', ') || 'Nothing to re-run'); loadRegs(); } };
$('regTable').onchange = async (e) => {
  if (!e.target.matches('[data-place]') || !e.target.value) return;
  const id = e.target.closest('[data-r]').dataset.r, [kind, v] = [e.target.value.slice(0, 1), e.target.value.slice(2)];
  const r = await act('POST', `/api/admin/registrations/${id}/place`, kind === 'p' ? { playerId: v } : { divisionId: v });
  if (r) { toast(r.note); loadRegs(); }
};
$('regTable').onclick = async (e) => {
  const tr = e.target.closest('[data-r]'); if (!tr) return;
  const id = tr.dataset.r;
  if (e.target.matches('[data-ignore]')) { if (await act('POST', `/api/admin/registrations/${id}/ignore`, {}, 'Ignored')) loadRegs(); }
  if (e.target.matches('[data-relay]')) { if (await act('POST', `/api/admin/registrations/${id}/relay`, {})) loadRegs(); }
  if (e.target.matches('[data-rerun]')) { const r = await act('POST', `/api/admin/registrations/${id}/reprocess`, {}); if (r) { toast(`${LABELS[r.outcome] || r.outcome}: ${r.note}`); loadRegs(); } }
  if (e.target.matches('[data-raw]')) {
    const r = await act('GET', `/api/admin/registrations/${id}`); if (!r) return;
    let pretty = r.raw; try { pretty = JSON.stringify(JSON.parse(r.raw), null, 2); } catch { /* keep */ }
    openDialog(`<div class="dlg"><h2>Registration #${r.id}</h2><pre>${esc(pretty)}</pre><div class="row"><span class="spacer"></span><button class="btn" data-close>Close</button></div></div>`);
  }
};
$('regFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('regCsv').value = await f.text(); };
$('regImport').onclick = async () => {
  const text = $('regCsv').value.trim(); if (!text) return toast('Choose or paste a CSV first', true);
  const t = await act('POST', '/api/admin/registrations/import', { text });
  if (t) { toast(Object.entries(t).map(([k, v]) => `${v} ${LABELS[k] || k}`).join(', ')); $('regCsv').value = ''; $('regFile').value = ''; loadRegs(); }
};
$('mSave').onclick = async () => {
  const body = { firstName: $('mFirst').value.trim(), lastName: $('mLast').value.trim(), birthdate: $('mDob').value || undefined, program: $('mDiv').value || undefined };
  if (!body.firstName || !body.lastName) return toast('First and last name are required', true);
  const r = await act('POST', '/api/admin/registrations/manual', body);
  if (r) { toast(`${LABELS[r.outcome] || r.outcome}: ${r.note}`); ['mFirst', 'mLast', 'mDob'].forEach((i) => ($(i).value = '')); loadRegs(); }
};

/* ---------- activity tab ---------- */
async function loadLog() { S.log = await call('GET', '/api/admin/audit').catch(() => null); if (S.tab === 'log') renderLog(); }
function renderLog() {
  if (!S.log) { $('logTable').innerHTML = '<tr><td class="note">Loading…</td></tr>'; return; }
  $('logTable').innerHTML = '<tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Player</th><th>Detail</th></tr>'
    + S.log.map((a) => `<tr><td class="sub">${esc(a.at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action.replace(/_/g, ' '))}</td><td>${esc(a.player_name || '')}</td><td class="mono">${esc(a.detail)}</td></tr>`).join('');
}
$('logRefresh').onclick = loadLog;

/* ---------- tabs ---------- */
const VIEWS = ['overview', 'players', 'regs', 'divisions', 'log'];
function setTab(t) {
  const btn = document.querySelector(`[data-tab="${t}"]`);
  if (!btn || (btn.hasAttribute('data-admin') && !isAdmin())) t = 'overview';
  S.tab = t;
  document.querySelectorAll('#tabs button').forEach((x) => x.setAttribute('aria-selected', x.dataset.tab === t));
  VIEWS.forEach((v) => ($('view-' + v).hidden = v !== t));
  try { localStorage.setItem('sereg-tab', t); } catch { /* private mode */ }
  if (t === 'regs') loadRegs();
  if (t === 'log') loadLog();
  render();
}
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

/* ---------- gates ---------- */
function gate(html, bind) { $('app').hidden = true; const g = $('gate'); g.innerHTML = html; g.hidden = false; bind(g); }
function loginGate() {
  gate(`<form class="gate" id="lf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">SE Registration</small>Admin login</h1>
    <input type="text" id="lu" placeholder="Username" autocomplete="username" required aria-label="Username">
    <input type="password" id="lp" placeholder="Password" autocomplete="current-password" required aria-label="Password">
    <p class="err-text" id="le"></p><button class="btn primary" type="submit">Log in</button><a href="/" class="note">← Back to seat counts</a></form>`, (g) => {
    g.querySelector('#lu').focus();
    g.querySelector('#lf').onsubmit = async (e) => {
      e.preventDefault();
      try { await call('POST', '/api/login', { username: g.querySelector('#lu').value, password: g.querySelector('#lp').value }); location.reload(); }
      catch (err) { g.querySelector('#le').textContent = err.message; }
    };
  });
}
function viewerGate() {
  gate(`<form class="gate" id="vf"><h1><small style="display:block;font-size:.8rem;letter-spacing:.14em;color:var(--muted)">SE Baseball</small>Registration</h1>
    <p class="note">Enter the league's code to see seat counts.</p>
    <input type="password" id="vc" placeholder="League code" required aria-label="League code">
    <p class="err-text" id="ve"></p><button class="btn primary" type="submit">See seats</button><a href="/admin" class="note">Admin login</a></form>`, (g) => {
    g.querySelector('#vc').focus();
    g.querySelector('#vf').onsubmit = async (e) => {
      e.preventDefault();
      try { await call('POST', '/api/viewer', { code: g.querySelector('#vc').value }); location.reload(); }
      catch (err) { g.querySelector('#ve').textContent = err.message; }
    };
  });
}

/* ---------- boot ---------- */
async function refresh() {
  try {
    S.st = await call('GET', '/api/state');
    render();
    if (isAdmin() && S.tab !== 'regs') loadRegs(); // keep the inbox badge current
    if (isAdmin() && S.tab === 'log') loadLog();
  } catch (e) { toast(e.message, true); }
}
let refreshTimer;
function connect() {
  const es = new EventSource('/api/stream');
  es.addEventListener('change', () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 80); });
  es.onopen = () => { S.live = true; refresh(); };
  es.onerror = () => { S.live = false; if (S.st) renderWho(); };
}

(async () => {
  S.me = await call('GET', '/api/me');
  const wantsAdmin = location.pathname.startsWith('/admin');
  if (wantsAdmin && !S.me.admin) return loginGate();
  if (!S.me.viewer) return viewerGate();
  $('app').hidden = false;
  await refresh();
  let t = 'overview';
  try { t = localStorage.getItem('sereg-tab') || 'overview'; } catch { /* private mode */ }
  setTab(t);
  connect();
})();
