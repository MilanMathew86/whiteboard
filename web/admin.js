(() => {
  'use strict';

  // Admin console: manage accounts (spec §8). The server only serves this page to admins and
  // checks every request again, so this script just renders and asks for confirmation.

  const $ = (sel) => document.querySelector(sel);
  let csrfToken = '';
  let usersPage = 1;
  let auditPage = 1;

  const ACTION_LABELS = {
    'user.role': 'Changed role',
    'user.status': 'Changed status',
    'user.signout': 'Signed out everywhere',
    'user.delete': 'Deleted user',
    'account.delete': 'Deleted own account',
  };

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      if (res.status === 401) location.href = '/';
      throw new Error((data && data.error && data.error.message) || `The server returned an error (${res.status})`);
    }
    return data;
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const formatDate = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  function cell(content) {
    const td = el('td');
    if (content instanceof Node) td.append(content);
    else td.textContent = content;
    return td;
  }

  function pager(container, page, pages, total, go) {
    const prev = el('button', 'text-btn', 'Previous');
    const next = el('button', 'text-btn', 'Next');
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
    prev.addEventListener('click', () => go(page - 1));
    next.addEventListener('click', () => go(page + 1));
    container.replaceChildren(prev, el('span', '', `Page ${page} of ${pages} · ${total} in all`), next);
  }

  // ---------- Users ----------

  async function act(question, method, path, body, done) {
    if (!confirm(question)) return;
    try {
      await api(method, path, body);
      toast(done);
      loadUsers(usersPage);
    } catch (err) {
      toast(err.message);
    }
  }

  function actionsFor(u) {
    const box = el('div', 'board-actions');
    if (u.isYou) {
      box.append(el('span', 'admin-muted', 'This is you'));
      return box;
    }
    const url = `/api/admin/users/${encodeURIComponent(u.id)}`;
    const button = (label, handler, danger) => {
      const b = el('button', danger ? 'text-btn danger' : 'text-btn', label);
      b.addEventListener('click', handler);
      box.append(b);
    };
    if (u.status === 'active') {
      button('Disable', () => act(`Disable ${u.email}? They're signed out and can't sign in until enabled.`,
        'PATCH', url, { status: 'disabled' }, `Disabled ${u.email}`));
    } else {
      button('Enable', () => act(`Enable ${u.email}?`, 'PATCH', url, { status: 'active' }, `Enabled ${u.email}`));
    }
    if (u.role === 'admin') {
      button('Remove admin', () => act(`Remove admin rights from ${u.email}?`, 'PATCH', url, { role: 'user' },
        `${u.email} is no longer an admin`));
    } else {
      button('Make admin', () => act(`Make ${u.email} an admin? They'll be able to manage every account.`,
        'PATCH', url, { role: 'admin' }, `${u.email} is now an admin`));
    }
    button('Sign out', () => act(`Sign ${u.email} out on all their devices?`, 'POST', `${url}/signout`, undefined,
      `Signed ${u.email} out`));
    button('Delete', () => act(`Delete ${u.email}'s account and every board they own? This can't be undone.`,
      'DELETE', url, undefined, `Deleted ${u.email}`), true);
    return box;
  }

  async function loadUsers(page = 1) {
    const q = $('#searchInput').value.trim();
    let data;
    try {
      data = await api('GET', `/api/admin/users?page=${page}&q=${encodeURIComponent(q)}`);
    } catch (err) {
      toast(err.message);
      return;
    }
    usersPage = data.page;
    const rows = data.users.map((u) => {
      const tr = el('tr');
      const who = el('div', 'admin-user', u.name);
      who.append(el('span', '', u.email));
      const status = el('span', `admin-badge ${u.status}`, u.status === 'active' ? 'Active' : 'Disabled');
      tr.append(
        cell(who), cell(u.role === 'admin' ? 'Admin' : 'User'), cell(status), cell(String(u.boards)),
        cell(formatSize(u.storage)), cell(formatDate(u.createdAt)), cell(formatDate(u.lastLoginAt)), cell(actionsFor(u)),
      );
      return tr;
    });
    $('#usersBody').replaceChildren(...(rows.length ? rows : [emptyRow(8, 'No users match that search.')]));
    pager($('#usersPager'), data.page, data.pages, data.total, loadUsers);
  }

  function emptyRow(span, text) {
    const tr = el('tr');
    const td = el('td', 'admin-muted', text);
    td.colSpan = span;
    tr.append(td);
    return tr;
  }

  // ---------- Audit log ----------

  function describe(e) {
    const d = e.details || {};
    if (e.action === 'user.role' || e.action === 'user.status') return `${d.old} → ${d.new}`;
    if (e.action === 'user.delete' || e.action === 'account.delete') return `${d.boards || 0} boards deleted`;
    return '';
  }

  async function loadAudit(page = 1) {
    let data;
    try {
      data = await api('GET', `/api/admin/audit?page=${page}&action=${encodeURIComponent($('#auditFilter').value)}`);
    } catch (err) {
      toast(err.message);
      return;
    }
    auditPage = data.page;
    const rows = data.entries.map((e) => {
      const tr = el('tr');
      tr.append(
        cell(formatDate(e.createdAt)), cell(e.actor || (e.action === 'account.delete' ? 'The user' : 'Deleted admin')),
        cell(ACTION_LABELS[e.action] || e.action), cell(e.targetEmail || `Deleted user (${e.target})`), cell(describe(e)),
      );
      return tr;
    });
    $('#auditBody').replaceChildren(...(rows.length ? rows : [emptyRow(5, 'Nothing logged yet.')]));
    pager($('#auditPager'), data.page, data.pages, data.total, loadAudit);
  }

  // ---------- Tabs & start-up ----------

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const name = tab.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((t) => {
        t.classList.toggle('active', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      $('#usersTab').hidden = name !== 'users';
      $('#auditTab').hidden = name !== 'audit';
      if (name === 'users') loadUsers(usersPage);
      else loadAudit(auditPage);
    });
  });

  $('#searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    loadUsers(1);
  });
  $('#auditFilter').addEventListener('change', () => loadAudit(1));

  (async () => {
    try {
      const me = await api('GET', '/api/me');
      if (!me.user || me.user.role !== 'admin') { location.href = '/'; return; }
      csrfToken = me.csrfToken;
      loadUsers(1);
    } catch (err) {
      toast(err.message);
    }
  })();
})();
