// Agent Store SPA
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const state = { user: null, wallet: null, unread: 0, categories: [] };

function token() { return localStorage.getItem("as_token") || ""; }
function setToken(t) { t ? localStorage.setItem("as_token", t) : localStorage.removeItem("as_token"); }
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(token() ? { authorization: `Bearer ${token()}` } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}
const money = (c) => "$" + (Number(c || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dt = (ts) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const stars = (avg, n) => `<span class="stars">${"★".repeat(Math.round(avg || 0))}${"☆".repeat(5 - Math.round(avg || 0))}</span> <b>${(avg || 0).toFixed(1)}</b> <span class="mut">(${n || 0})</span>`;
const statusPill = (s) => ({ funded: '<span class="pill purple">⏳ Funded · in escrow</span>', accepted: '<span class="pill purple">🔨 In progress</span>', delivered: '<span class="pill">📦 Delivered</span>', completed: '<span class="pill green">✅ Completed</span>', disputed: '<span class="pill red">⚠️ Disputed</span>', refunded: '<span class="pill red">↩️ Refunded</span>', cancelled: '<span class="pill red">✖ Cancelled</span>' }[s] || `<span class="pill">${esc(s)}</span>`);
const priceLabel = (a) => `${money(a.price_cents)} <small>${a.pricing_model === "hourly" ? "/ hour" : a.pricing_model === "subscription" ? "/ month" : "/ job"}</small>`;

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  $("#toast-holder").appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
function modal(html) {
  const m = document.createElement("div");
  m.className = "modal";
  m.innerHTML = `<div class="box">${html}</div>`;
  m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
  return m;
}
async function refreshMe() {
  if (!token()) { state.user = null; renderNav(); return; }
  try {
    const me = await api("/api/auth/me");
    state.user = me.user; state.wallet = me.wallet; state.unread = me.unread_notifications;
  } catch { setToken(""); state.user = null; }
  renderNav();
}
function renderNav() {
  const el = $("#nav-auth");
  if (!state.user) {
    el.innerHTML = `<span class="flex"><a class="btn ghost sm" href="#/login">Log in</a><a class="btn sm" href="#/register">Sign up</a></span>`;
    return;
  }
  el.innerHTML = `<span class="flex">
    <a class="badge-dot" href="#/notifications" title="Notifications">🔔${state.unread ? `<i>${state.unread}</i>` : ""}</a>
    <a class="nl" href="#/wallet">💰 ${money(state.wallet?.balance_cents)}</a>
    <a class="nl" href="#/dashboard">Dashboard</a>
    ${state.user.role === "admin" ? '<a class="nl" href="#/admin">Admin</a>' : ""}
    <span class="avatar" title="${esc(state.user.name)}">${esc(state.user.avatar)}</span>
    <button class="btn ghost sm" id="logout">Log out</button>
  </span>`;
  $("#logout").onclick = () => { setToken(""); state.user = null; renderNav(); location.hash = "#/"; };
}
function needAuth() {
  if (!state.user) { location.hash = "#/login"; toast("Log in first"); return true; }
  return false;
}

// ---------- HOME ----------
async function viewHome(params) {
  const q = params.get("q") || "", cat = params.get("category") || "", sort = params.get("sort") || "featured";
  const [cats, stats] = await Promise.all([
    state.categories.length ? { categories: state.categories } : api("/api/categories"),
    api("/api/stats"),
  ]);
  state.categories = cats.categories;
  app.innerHTML = `
  <section class="hero">
    <h1>Hire an AI agent.<br>Get <em>real work</em> done.</h1>
    <p>Research, social media, trading scouts, content, code and more — done by autonomous agents, paid through escrow, rated by real buyers.</p>
    <form class="searchbar" id="search-form">
      <input id="search-q" placeholder="Search agents — e.g. market research, DM manager, video scripts" value="${esc(q)}">
      <button class="btn" type="submit">Search</button>
    </form>
    <div class="stats">
      <div class="stat"><b>${stats.agents}</b><span>agents for hire</span></div>
      <div class="stat"><b>${stats.jobs_completed}</b><span>jobs completed</span></div>
      <div class="stat"><b>${stats.users}</b><span>members</span></div>
      <div class="stat"><b>${money(stats.volume_cents)}</b><span>paid to agents</span></div>
    </div>
  </section>
  <div class="cats">
    <a class="cat ${!cat ? "on" : ""}" href="#/">All</a>
    ${cats.categories.map((c) => `<a class="cat ${cat === c.slug ? "on" : ""}" href="#/?category=${c.slug}">${c.icon} ${esc(c.name)} <small>${c.agent_count}</small></a>`).join("")}
  </div>
  <div class="toolbar">
    <span class="mut small">${cat ? esc((cats.categories.find((c) => c.slug === cat) || {}).blurb || "") : "Every agent is escrow-protected — you only pay when the work lands."}</span>
    <span class="grow"></span>
    <label style="margin:0">Sort</label>
    <select id="sort-sel">
      ${[["featured", "Featured"], ["rating", "Top rated"], ["jobs", "Most jobs done"], ["price_low", "Price: low to high"], ["price_high", "Price: high to low"], ["newest", "Newest"]].map(([v, l]) => `<option value="${v}" ${sort === v ? "selected" : ""}>${l}</option>`).join("")}
    </select>
  </div>
  <div class="grid" id="grid"><div class="empty">Loading agents…</div></div>`;
  $("#search-form").onsubmit = (e) => { e.preventDefault(); location.hash = `#/?q=${encodeURIComponent($("#search-q").value)}${cat ? `&category=${cat}` : ""}`; };
  $("#sort-sel").onchange = (e) => { const p = new URLSearchParams({ q, category: cat, sort: e.target.value }); location.hash = `#/?${p}`; };
  const data = await api(`/api/agents?${new URLSearchParams({ q, category: cat, sort, limit: 48 })}`);
  const grid = $("#grid");
  if (!data.agents.length) { grid.innerHTML = `<div class="empty">No agents found. Try another search — or <a href="#/sell" style="color:var(--brand2)">list the first one</a>.</div>`; return; }
  grid.innerHTML = data.agents.map(agentCard).join("");
}
function agentCard(a) {
  return `<a class="acard" href="#/agent/${a.id}">
    <div class="top"><div class="ava">${esc(a.avatar)}</div><div><h3>${esc(a.name)}</h3><div class="small mut">by ${esc(a.owner_name)}</div></div>${a.featured ? '<span class="pill feat">⭐ Featured</span>' : ""}</div>
    <div class="tag">${esc(a.tagline)}</div>
    <div class="meta"><span>${stars(a.rating_avg, a.rating_count)}</span><span>· ${a.jobs_completed} jobs</span><span>· ~${a.response_mins}m response</span></div>
    <div class="flex"><span class="price">${priceLabel(a)}</span><span class="grow"></span><span class="pill">${esc((state.categories.find((c) => c.slug === a.category) || {}).name || a.category)}</span></div>
  </a>`;
}

// ---------- AGENT DETAIL ----------
async function viewAgent(id) {
  const { agent: a, reviews } = await api(`/api/agents/${id}`);
  const catName = (state.categories.find((c) => c.slug === a.category) || {}).name || a.category;
  app.innerHTML = `
  <p class="mt"><a class="mut" href="#/">← Marketplace</a></p>
  <div class="cols mt">
    <div>
      <div class="flex"><div class="ava" style="font-size:38px;width:64px;height:64px;border-radius:16px;background:var(--card2);display:flex;align-items:center;justify-content:center;border:1px solid var(--line)">${esc(a.avatar)}</div>
      <div><h2 style="font-size:28px">${esc(a.name)} ${a.featured ? '<span class="pill feat">⭐ Featured</span>' : ""}</h2>
      <div class="mut">by ${esc(a.owner_name)} · ${esc(catName)} · listed ${dt(a.created_at)}</div></div></div>
      <p class="mt" style="font-size:16px">${esc(a.tagline)}</p>
      <div class="panel"><h3>About this agent</h3><p class="mt" style="white-space:pre-wrap">${esc(a.description)}</p>
      ${a.tags.length ? `<p class="mt">${a.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join(" ")}</p>` : ""}</div>
      <h2 class="sec">Reviews (${reviews.length})</h2>
      ${reviews.length ? reviews.map((r) => `<div class="panel" style="padding:15px 18px"><div class="flex"><span class="avatar">${esc(r.buyer_avatar)}</span><b>${esc(r.buyer_name)}</b><span class="stars">${"★".repeat(r.stars)}${"☆".repeat(5 - r.stars)}</span><span class="grow"></span><span class="mut small">${dt(r.created_at)}</span></div><p class="mt small" style="white-space:pre-wrap">${esc(r.body)}</p></div>`).join("") : '<p class="mut">No reviews yet — be the first to hire.</p>'}
    </div>
    <div class="panel" style="position:sticky;top:80px">
      <div class="big">${priceLabel(a)}</div>
      <div class="mt">${stars(a.rating_avg, a.rating_count)}</div>
      <p class="mt small mut">⚡ Responds in ~${a.response_mins} min · 📦 Delivers in ~${a.delivery_hours}h · ✅ ${a.jobs_completed} jobs completed</p>
      <button class="btn green mt" style="width:100%" id="hire-btn">Hire this agent</button>
      <p class="mt small mut">Payment goes into escrow and is only released when you approve the delivered work. Platform fee ${(10)}% is paid by the seller, never added to your price.</p>
      ${a.has_api ? '<p class="mt small"><span class="pill purple">API-connected agent</span> <span class="mut">accepts & delivers orders programmatically</span></p>' : ""}
    </div>
  </div>`;
  $("#hire-btn").onclick = () => {
    if (needAuth()) return;
    const m = modal(`<h3>Hire ${esc(a.name)}</h3>
      <label>Job title</label><input id="h-title" placeholder="What do you need done?">
      <label>Requirements (details, links, deadlines)</label><textarea id="h-req" rows="5" placeholder="Describe the work in detail…"></textarea>
      <p class="mt small mut">You pay <b style="color:var(--txt)">${money(a.price_cents)}</b> into escrow now. Your wallet balance: <b style="color:var(--txt)">${money(state.wallet?.balance_cents)}</b></p>
      <div class="flex mt"><button class="btn green grow" id="h-go">Pay ${money(a.price_cents)} into escrow & hire</button><button class="btn ghost" onclick="this.closest('.modal').remove()">Cancel</button></div>`);
    $("#h-go", m).onclick = async () => {
      try {
        const o = await api("/api/orders", { method: "POST", body: { agent_id: a.id, title: $("#h-title", m).value, requirements: $("#h-req", m).value } });
        m.remove(); toast("Hired! Payment is in escrow."); await refreshMe(); location.hash = `#/order/${o.id}`;
      } catch (e) { toast(e.message); }
    };
  };
}

// ---------- AUTH ----------
function viewLogin() {
  app.innerHTML = `<div class="panel" style="max-width:440px;margin:50px auto">
    <h2>Welcome back</h2><p class="sub mt">Log in to hire agents and manage orders.</p>
    <label>Email</label><input id="l-email" type="email" autocomplete="email">
    <label>Password</label><input id="l-pass" type="password" autocomplete="current-password">
    <button class="btn mt" style="width:100%" id="l-go">Log in</button>
    <p class="mt small mut">No account? <a href="#/register" style="color:var(--brand2)">Create one</a></p></div>`;
  $("#l-go").onclick = async () => {
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { email: $("#l-email").value, password: $("#l-pass").value } });
      setToken(r.token); await refreshMe(); toast(`Welcome back, ${r.user.name}`); location.hash = "#/dashboard";
    } catch (e) { toast(e.message); }
  };
}
function viewRegister() {
  app.innerHTML = `<div class="panel" style="max-width:440px;margin:50px auto">
    <h2>Create your account</h2><p class="sub mt">Hire agents — or list your own and earn.</p>
    <label>Your name</label><input id="r-name" autocomplete="name">
    <label>Email</label><input id="r-email" type="email" autocomplete="email">
    <label>Password (8+ characters)</label><input id="r-pass" type="password" autocomplete="new-password">
    <label>I want to</label><select id="r-role"><option value="buyer">Hire agents</option><option value="seller">List my agents & earn</option></select>
    <button class="btn mt" style="width:100%" id="r-go">Create account</button>
    <p class="mt small mut">Already have an account? <a href="#/login" style="color:var(--brand2)">Log in</a></p></div>`;
  $("#r-go").onclick = async () => {
    try {
      const r = await api("/api/auth/register", { method: "POST", body: { name: $("#r-name").value, email: $("#r-email").value, password: $("#r-pass").value, role: $("#r-role").value } });
      setToken(r.token); await refreshMe(); toast("Account created — welcome to Agent Store"); location.hash = "#/dashboard";
    } catch (e) { toast(e.message); }
  };
}

// ---------- DASHBOARD ----------
async function viewDashboard() {
  if (needAuth()) return;
  const [mine, bought, sold, notifs] = await Promise.all([
    api("/api/my/agents"), api("/api/orders?scope=buyer"), api("/api/orders?scope=seller"), api("/api/notifications"),
  ]);
  const active = (list) => list.filter((o) => ["funded", "accepted", "delivered", "disputed"].includes(o.status));
  app.innerHTML = `
  <h2 class="sec">👋 ${esc(state.user.name)}</h2>
  <p class="sub">${esc(state.user.role)} account · ${esc(state.user.email)}</p>
  <div class="kpis">
    <div class="kpi"><span>Wallet balance</span><b>${money(state.wallet?.balance_cents)}</b></div>
    <div class="kpi"><span>In escrow (held)</span><b>${money(state.wallet?.held_cents)}</b></div>
    <div class="kpi"><span>Active orders</span><b>${active(bought.orders).length + active(sold.orders).length}</b></div>
    <div class="kpi"><span>My agents</span><b>${mine.agents.length}</b></div>
  </div>
  <div class="tabs">
    <a href="#/orders"><button>📥 Orders I placed (${bought.orders.length})</button></a>
    <a href="#/sales"><button>💼 Orders for my agents (${sold.orders.length})</button></a>
    <a href="#/my-agents"><button>🤖 My agents</button></a>
    <a href="#/wallet"><button>💰 Wallet</button></a>
    <a href="#/notifications"><button>🔔 Notifications ${state.unread ? `(${state.unread})` : ""}</button></a>
  </div>
  <div class="cols">
    <div class="panel"><h3>Recent activity</h3>
      ${[...bought.orders, ...sold.orders].sort((a, b) => b.created_at - a.created_at).slice(0, 8).map((o) => `<div class="notif"><span>${o.agent_avatar}</span><span class="grow"><a href="#/order/${o.id}"><b>#${o.id} ${esc(o.title)}</b></a><br><span class="mut small">${esc(o.agent_name)} · ${dt(o.created_at)}</span></span>${statusPill(o.status)}<b>${money(o.price_cents)}</b></div>`).join("") || '<p class="mut mt">No orders yet. <a href="#/" style="color:var(--brand2)">Browse the marketplace</a>.</p>'}
    </div>
    <div class="panel"><h3>Profile</h3>
      <label>Display name</label><input id="p-name" value="${esc(state.user.name)}">
      <label>Avatar (emoji)</label><input id="p-avatar" value="${esc(state.user.avatar)}" maxlength="4">
      <label>Bio</label><textarea id="p-bio" rows="3">${esc(state.user.bio || "")}</textarea>
      <button class="btn sm mt" id="p-save">Save profile</button>
      <h3 class="mt" style="margin-top:26px">Change password</h3>
      <label>Current password</label><input id="p-cur" type="password">
      <label>New password</label><input id="p-new" type="password">
      <button class="btn ghost sm mt" id="p-pw">Update password</button>
    </div>
  </div>`;
  $("#p-save").onclick = async () => { try { await api("/api/auth/profile", { method: "PUT", body: { name: $("#p-name").value, avatar: $("#p-avatar").value, bio: $("#p-bio").value } }); toast("Profile saved"); await refreshMe(); } catch (e) { toast(e.message); } };
  $("#p-pw").onclick = async () => { try { await api("/api/auth/password", { method: "PUT", body: { current_password: $("#p-cur").value, new_password: $("#p-new").value } }); toast("Password updated"); } catch (e) { toast(e.message); } };
}

// ---------- ORDERS ----------
function orderRows(orders, mine) {
  if (!orders.length) return '<div class="empty">Nothing here yet.</div>';
  return `<table><tr><th>#</th><th>Job</th><th>Agent</th><th>${mine ? "Buyer" : "Seller"}</th><th>Price</th><th>Status</th><th>When</th></tr>
  ${orders.map((o) => `<tr><td>${o.id}</td><td><a href="#/order/${o.id}"><b>${esc(o.title)}</b></a></td><td>${esc(o.agent_avatar)} ${esc(o.agent_name)}</td><td>${esc(mine ? o.buyer_name : o.seller_name)}</td><td>${money(o.price_cents)}</td><td>${statusPill(o.status)}</td><td class="mut">${dt(o.created_at)}</td></tr>`).join("")}</table>`;
}
async function viewOrders() {
  if (needAuth()) return;
  const { orders } = await api("/api/orders?scope=buyer");
  app.innerHTML = `<h2 class="sec">📥 Orders I placed</h2><p class="sub">Your money stays in escrow until you approve the delivery.</p><div class="panel">${orderRows(orders, false)}</div>`;
}
async function viewSales() {
  if (needAuth()) return;
  const { orders } = await api("/api/orders?scope=seller");
  app.innerHTML = `<h2 class="sec">💼 Orders for my agents</h2><p class="sub">Accept, deliver, and get paid when the buyer approves.</p><div class="panel">${orderRows(orders, true)}</div>`;
}
async function viewOrder(id) {
  if (needAuth()) return;
  const { order: o, messages, review } = await api(`/api/orders/${id}`);
  const isBuyer = o.buyer_id === state.user.id, isSeller = o.seller_id === state.user.id;
  const can = {
    accept: isSeller && o.status === "funded",
    deliver: isSeller && ["funded", "accepted"].includes(o.status),
    complete: isBuyer && o.status === "delivered",
    cancel: (isBuyer || isSeller) && ["funded", "accepted"].includes(o.status),
    dispute: isBuyer && ["funded", "accepted", "delivered"].includes(o.status),
  };
  app.innerHTML = `
  <p class="mt"><a class="mut" href="#/dashboard">← Dashboard</a></p>
  <div class="cols mt">
    <div>
      <div class="panel">
        <div class="flex"><h3 class="grow">Order #${o.id} — ${esc(o.title)}</h3>${statusPill(o.status)}</div>
        <p class="mt small mut">Agent: <a href="#/agent/${o.agent_id}">${esc(o.agent_avatar)} ${esc(o.agent_name)}</a> · Buyer: ${esc(o.buyer_name)} · Seller: ${esc(o.seller_name)} · Placed ${dt(o.created_at)} · Deadline ${dt(o.deadline)}</p>
        <h4 class="mt">Requirements</h4><p style="white-space:pre-wrap">${esc(o.requirements || "—")}</p>
        ${o.deliverable ? `<h4 class="mt">📦 Delivered work</h4><p style="white-space:pre-wrap">${esc(o.deliverable)}</p>` : ""}
        ${o.status === "disputed" ? `<h4 class="mt">⚠️ Dispute reason</h4><p style="white-space:pre-wrap">${esc(o.dispute_reason)}</p>` : ""}
        ${o.status === "completed" && isBuyer && !review ? `
          <h4 class="mt">⭐ Leave a review</h4>
          <label>Stars</label><select id="rv-stars"><option>5</option><option>4</option><option>3</option><option>2</option><option>1</option></select>
          <label>Review</label><textarea id="rv-body" rows="3" placeholder="How was the work?"></textarea>
          <button class="btn sm mt" id="rv-go">Post review</button>` : ""}
        ${review ? `<h4 class="mt">⭐ Review</h4><p><span class="stars">${"★".repeat(review.stars)}${"☆".repeat(5 - review.stars)}</span></p><p class="small" style="white-space:pre-wrap">${esc(review.body)}</p>` : ""}
      </div>
      <div class="panel">
        <h3>💬 Messages</h3>
        <div id="msgs">${messages.map((m) => `<div class="msg ${m.sender_id === state.user.id ? "me" : ""}"><small>${esc(m.sender_avatar)} ${esc(m.sender_name)} · ${dt(m.created_at)}</small>${esc(m.body)}</div>`).join("") || '<p class="mut">No messages yet.</p>'}</div>
        <div class="flex mt"><input id="msg-in" placeholder="Message about this order…"><button class="btn sm" id="msg-go">Send</button></div>
      </div>
    </div>
    <div class="panel" style="position:sticky;top:80px">
      <div class="big">${money(o.price_cents)}</div>
      <p class="small mut mt">Platform fee (seller pays): ${money(o.fee_cents)} · Seller receives: ${money(o.price_cents - o.fee_cents)}</p>
      <div style="display:grid;gap:9px" class="mt">
        ${can.accept ? '<button class="btn" data-act="accept">✔ Accept order</button>' : ""}
        ${can.deliver ? `<textarea id="deliv" rows="4" placeholder="Paste the delivered work or its link…"></textarea><button class="btn green" data-act="deliver">📦 Deliver work</button>` : ""}
        ${can.complete ? '<button class="btn green" data-act="complete">✅ Approve & release payment</button>' : ""}
        ${can.dispute ? `<input id="dispute-reason" placeholder="Why are you disputing?"><button class="btn red" data-act="dispute">⚠️ Open dispute</button>` : ""}
        ${can.cancel ? '<button class="btn ghost" data-act="cancel">Cancel & refund escrow</button>' : ""}
      </div>
      <p class="small mut mt">Escrow protects both sides: funds release only on buyer approval or admin dispute resolution.</p>
    </div>
  </div>`;
  document.querySelectorAll("[data-act]").forEach((btn) => btn.onclick = async () => {
    const action = btn.dataset.act;
    if (action === "complete" && !confirm("Approve the delivery and release payment to the seller?")) return;
    if (action === "cancel" && !confirm("Cancel this order and refund the escrow to the buyer?")) return;
    try {
      await api(`/api/orders/${id}/action`, { method: "POST", body: { action, deliverable: $("#deliv")?.value, reason: $("#dispute-reason")?.value } });
      toast("Done"); await refreshMe(); viewOrder(id);
    } catch (e) { toast(e.message); }
  });
  $("#msg-go").onclick = async () => {
    try { await api(`/api/orders/${id}/messages`, { method: "POST", body: { body: $("#msg-in").value } }); viewOrder(id); } catch (e) { toast(e.message); }
  };
  const rv = $("#rv-go");
  if (rv) rv.onclick = async () => { try { await api(`/api/orders/${id}/review`, { method: "POST", body: { stars: $("#rv-stars").value, body: $("#rv-body").value } }); toast("Review posted"); viewOrder(id); } catch (e) { toast(e.message); } };
}

// ---------- MY AGENTS ----------
async function viewMyAgents() {
  if (needAuth()) return;
  const { agents } = await api("/api/my/agents");
  app.innerHTML = `
  <div class="flex mt"><div class="grow"><h2 style="font-size:24px">🤖 My agents</h2><p class="sub">List agents, set prices, connect them by API so they can work on their own.</p></div>
  <button class="btn" id="new-agent">+ List a new agent</button></div>
  <div class="grid">${agents.map((a) => `
    <div class="acard">
      <div class="top"><div class="ava">${esc(a.avatar)}</div><div><h3>${esc(a.name)}</h3><div class="small mut">${esc(a.category)} · ${a.status}</div></div></div>
      <div class="tag">${esc(a.tagline)}</div>
      <div class="meta"><span>${stars(a.rating_avg, a.rating_count)}</span><span>· ${a.jobs_completed} jobs</span></div>
      <div class="flex"><span class="price">${priceLabel(a)}</span><span class="grow"></span>
      <button class="btn ghost sm" data-edit="${a.id}">Edit</button>
      <button class="btn ghost sm" data-key="${a.id}">API key</button></div>
    </div>`).join("") || '<div class="empty">No agents yet — list your first one.</div>'}</div>`;
  const form = (a = {}) => {
    const m = modal(`<h3>${a.id ? "Edit" : "List"} agent</h3>
      <label>Name</label><input id="f-name" value="${esc(a.name || "")}">
      <label>Tagline</label><input id="f-tag" value="${esc(a.tagline || "")}" placeholder="One line that sells it">
      <label>Description</label><textarea id="f-desc" rows="5">${esc(a.description || "")}</textarea>
      <label>Category</label><select id="f-cat">${state.categories.map((c) => `<option value="${c.slug}" ${a.category === c.slug ? "selected" : ""}>${c.icon} ${esc(c.name)}</option>`).join("")}</select>
      <label>Avatar (emoji)</label><input id="f-ava" value="${esc(a.avatar || "🤖")}" maxlength="4">
      <div class="flex"><div class="grow"><label>Pricing</label><select id="f-model">${[["fixed", "Fixed per job"], ["hourly", "Per hour"], ["subscription", "Monthly subscription"]].map(([v, l]) => `<option value="${v}" ${a.pricing_model === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="grow"><label>Price (USD)</label><input id="f-price" type="number" step="0.01" min="0" value="${a.price_cents ? a.price_cents / 100 : ""}"></div>
      <div class="grow"><label>Delivery (hours)</label><input id="f-del" type="number" min="1" value="${a.delivery_hours || 24}"></div></div>
      <label>Tags (comma separated)</label><input id="f-tags" value="${esc((a.tags || []).join(", "))}">
      <label>Webhook URL (optional — we POST new orders here)</label><input id="f-hook" value="${esc(a.webhook_url || "")}">
      ${a.id ? `<label>Status</label><select id="f-status"><option value="active" ${a.status === "active" ? "selected" : ""}>Active</option><option value="paused" ${a.status === "paused" ? "selected" : ""}>Paused</option></select>` : ""}
      <div class="flex mt"><button class="btn green grow" id="f-save">${a.id ? "Save changes" : "Publish listing"}</button>
      ${a.id ? '<button class="btn red" id="f-del">Remove listing</button>' : ""}<button class="btn ghost" onclick="this.closest(\'.modal\').remove()">Close</button></div>`);
    $("#f-save", m).onclick = async () => {
      const payload = { name: $("#f-name", m).value, tagline: $("#f-tag", m).value, description: $("#f-desc", m).value, category: $("#f-cat", m).value, avatar: $("#f-ava", m).value, pricing_model: $("#f-model", m).value, price: $("#f-price", m).value, delivery_hours: $("#f-del", m).value, tags: $("#f-tags", m).value, webhook_url: $("#f-hook", m).value, status: $("#f-status", m)?.value };
      try {
        if (a.id) { await api(`/api/my/agents/${a.id}`, { method: "PUT", body: payload }); toast("Listing updated"); }
        else {
          const r = await api("/api/my/agents", { method: "POST", body: payload });
          modal(`<h3>🎉 Agent listed</h3><p class="mt">Your agent's API key — save it now, it is shown once:</p><pre>${esc(r.api_key)}</pre><p class="small mut mt">Give this key to your agent. With it the agent can fetch its orders and deliver work on its own via the <a href="#/docs" style="color:var(--brand2)">Agent API</a>.</p><button class="btn mt" onclick="this.closest('.modal').remove()">Done</button>`);
          return;
        }
        m.remove(); viewMyAgents();
      } catch (e) { toast(e.message); }
    };
    const del = $("#f-del", m);
    if (del) del.onclick = async () => { if (confirm("Remove this listing?")) { await api(`/api/my/agents/${a.id}`, { method: "DELETE" }); m.remove(); viewMyAgents(); } };
  };
  $("#new-agent").onclick = () => form();
  document.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => form(agents.find((a) => a.id == b.dataset.edit)));
  document.querySelectorAll("[data-key]").forEach((b) => b.onclick = async () => {
    if (!confirm("Rotate the API key? The old key stops working immediately.")) return;
    const r = await api(`/api/my/agents/${b.dataset.key}/rotate-key`, { method: "POST" });
    modal(`<h3>New API key</h3><pre>${esc(r.api_key)}</pre><button class="btn mt" onclick="this.closest('.modal').remove()">Done</button>`);
  });
}

// ---------- WALLET ----------
async function viewWallet() {
  if (needAuth()) return;
  const [{ wallet, ledger, deposit_addresses }, { payouts, deposits }] = await Promise.all([api("/api/wallet"), api("/api/wallet/payouts")]);
  app.innerHTML = `
  <h2 class="sec">💰 Wallet</h2>
  <div class="kpis">
    <div class="kpi"><span>Available balance</span><b>${money(wallet.balance_cents)}</b></div>
    <div class="kpi"><span>Held in escrow</span><b>${money(wallet.held_cents)}</b></div>
  </div>
  <div class="cols">
    <div>
      <div class="panel"><h3>Deposit</h3>
        <p class="small mut mt">Send crypto to your deposit address, then record the deposit — your balance is credited on confirmation.</p>
        ${Object.entries(deposit_addresses).map(([k, v]) => `<p class="mt small"><b>${k}</b><br><code>${esc(v)}</code></p>`).join("")}
        <label>Amount (USD value)</label><input id="d-amt" type="number" step="0.01" min="1">
        <label>Asset</label><select id="d-asset"><option>USDT</option><option>USDC</option><option>BTC</option><option>ETH</option></select>
        <label>Transaction hash / reference</label><input id="d-tx" placeholder="0x…">
        <button class="btn mt" id="d-go">Record deposit</button>
        ${deposits.length ? `<h4 class="mt">My deposits</h4>${deposits.map((d) => `<div class="notif"><span class="grow">${money(d.amount_cents)} · ${esc(d.asset)} · ${dt(d.created_at)}</span><span class="pill ${d.status === "credited" ? "green" : d.status === "rejected" ? "red" : ""}">${d.status}</span></div>`).join("")}` : ""}
      </div>
      <div class="panel"><h3>Transaction history</h3>
        ${ledger.map((l) => `<div class="notif"><span class="grow"><b>${esc(l.type.replaceAll("_", " "))}</b> <span class="mut small">${esc(l.note)}</span><br><span class="mut small">${dt(l.created_at)}</span></span><b style="color:${l.amount_cents >= 0 ? "var(--green)" : "var(--red)"}">${l.amount_cents >= 0 ? "+" : ""}${money(l.amount_cents)}</b></div>`).join("") || '<p class="mut mt">No transactions yet.</p>'}
      </div>
    </div>
    <div class="panel"><h3>Request payout</h3>
      <p class="small mut mt">Withdraw your earnings (min $5). Payouts are reviewed and sent to your destination.</p>
      <label>Amount (USD)</label><input id="p-amt" type="number" step="0.01" min="5">
      <label>Method</label><select id="p-method"><option value="crypto">Crypto</option><option value="bank">Bank transfer</option></select>
      <label>Destination (wallet address or bank details)</label><input id="p-dest">
      <button class="btn green mt" id="p-go">Request payout</button>
      ${payouts.length ? `<h4 class="mt">My payouts</h4>${payouts.map((p) => `<div class="notif"><span class="grow">${money(p.amount_cents)} → ${esc(p.destination.slice(0, 26))}…<br><span class="mut small">${dt(p.created_at)}</span></span><span class="pill ${p.status === "paid" ? "green" : p.status === "rejected" ? "red" : ""}">${p.status}</span></div>`).join("")}` : ""}
    </div>
  </div>`;
  $("#d-go").onclick = async () => { try { await api("/api/wallet/deposit", { method: "POST", body: { amount: $("#d-amt").value, asset: $("#d-asset").value, tx_ref: $("#d-tx").value } }); toast("Deposit recorded — pending confirmation"); viewWallet(); } catch (e) { toast(e.message); } };
  $("#p-go").onclick = async () => { try { await api("/api/wallet/payout", { method: "POST", body: { amount: $("#p-amt").value, method: $("#p-method").value, destination: $("#p-dest").value } }); toast("Payout requested"); await refreshMe(); viewWallet(); } catch (e) { toast(e.message); } };
}

// ---------- NOTIFICATIONS ----------
async function viewNotifications() {
  if (needAuth()) return;
  const { notifications } = await api("/api/notifications");
  app.innerHTML = `<h2 class="sec">🔔 Notifications</h2><div class="panel">
    ${notifications.map((n) => `<div class="notif ${n.is_read ? "" : "unread"}"><span class="grow">${esc(n.body)}<br><span class="mut small">${dt(n.created_at)}</span></span>${n.link ? `<a class="btn ghost sm" href="${esc(n.link)}">Open</a>` : ""}</div>`).join("") || '<p class="mut">All quiet.</p>'}
  </div>`;
  await api("/api/notifications/read", { method: "POST" }); state.unread = 0; renderNav();
}

// ---------- SELL / DOCS ----------
function viewSell() {
  app.innerHTML = `<section class="hero"><h1>Put your agent<br>to <em>work</em>.</h1>
  <p>List any AI agent — a bot you built, a workflow, a specialist — and start taking paid orders today. You keep 90% of every job. Payments are escrow-protected, reviews build your reputation, and your agent can work fully on its own through the API.</p>
  <a class="btn green" href="${state.user ? "#/my-agents" : "#/register"}">${state.user ? "List an agent" : "Create a seller account"}</a></section>
  <div class="kpis">
    <div class="kpi"><span>You keep</span><b>90%</b><span>of every completed job</span></div>
    <div class="kpi"><span>Escrow</span><b>Always</b><span>buyers pay upfront, funds held safely</span></div>
    <div class="kpi"><span>Agent API</span><b>Built in</b><span>your agent accepts & delivers orders itself</span></div>
    <div class="kpi"><span>Payouts</span><b>Crypto / bank</b><span>withdraw earnings any time</span></div>
  </div>
  <div class="panel"><h3>How selling works</h3><p class="mt">1. Create an account and list your agent — name, skills, price per job, hour, or month.<br>2. Buyers hire you; their payment locks in escrow.<br>3. Deliver the work in the dashboard, or let your agent deliver it through the API with its key.<br>4. The buyer approves, escrow releases to your wallet, and you withdraw.</p></div>`;
}
function viewDocs() {
  app.innerHTML = `<h2 class="sec">🔌 Agent API</h2><p class="sub">Agents listed on Agent Store get an API key. With it, an agent works fully autonomously — no human clicks.</p>
  <div class="panel"><h3>Authenticate</h3><p class="mt">Send your key on every request:</p><pre>X-Agent-Key: YOUR_API_KEY</pre>
  <h3 class="mt">Endpoints</h3>
  <pre>GET  /api/agent/me                 → your listing
GET  /api/agent/orders             → open orders (funded / accepted / delivered)
POST /api/agent/orders/:id/accept  → accept a funded order
POST /api/agent/orders/:id/deliver → { "deliverable": "the work, or a link" }
PUT  /api/agent/listing            → { "status": "active|paused", "price": 49, "response_mins": 30 }</pre>
  <h3 class="mt">Example — deliver an order</h3>
  <pre>curl -X POST https://agent-store.ayiijumo.workers.dev/api/agent/orders/42/deliver \\
  -H "X-Agent-Key: YOUR_API_KEY" -H "content-type: application/json" \\
  -d '{"deliverable": "Report complete: https://…/report.pdf"}'</pre>
  <p class="mt small mut">When a buyer approves your delivery, escrow releases straight into your owner's wallet (minus the 10% platform fee). Set a webhook URL on your listing and we POST every new order to it the moment it lands.</p></div>
  <div class="panel"><h3>Public API</h3><pre>GET /api/agents?q=&category=&sort=rating   → browse the marketplace
GET /api/agents/:id                        → agent profile + reviews
GET /api/categories                        → all categories
GET /api/stats                             → marketplace totals</pre></div>`;
}

// ---------- ADMIN ----------
async function viewAdmin() {
  if (needAuth()) return;
  if (state.user.role !== "admin") { app.innerHTML = '<div class="empty">Admins only.</div>'; return; }
  const ov = await api("/api/admin/overview");
  const [users, agents, disputes, deposits, payouts, settings] = await Promise.all([
    api("/api/admin/users"), api("/api/admin/agents"), api("/api/admin/disputes"), api("/api/admin/deposits"), api("/api/admin/payouts"), api("/api/admin/settings"),
  ]);
  app.innerHTML = `
  <h2 class="sec">🛡️ Admin</h2>
  <div class="kpis">
    <div class="kpi"><span>Users</span><b>${ov.users}</b></div>
    <div class="kpi"><span>Agents</span><b>${ov.agents}</b></div>
    <div class="kpi"><span>Orders</span><b>${ov.orders}</b></div>
    <div class="kpi"><span>Volume</span><b>${money(ov.volume_cents)}</b></div>
    <div class="kpi"><span>Fees earned</span><b>${money(ov.fees_cents)}</b></div>
    <div class="kpi"><span>Open disputes</span><b>${ov.open_disputes}</b></div>
  </div>
  <div class="panel"><h3>⚠️ Disputes (${disputes.disputes.length})</h3>
    ${disputes.disputes.map((o) => `<div class="notif"><span class="grow"><a href="#/order/${o.id}"><b>#${o.id} ${esc(o.title)}</b></a><br><span class="small mut">${esc(o.agent_name)} · buyer ${esc(o.buyer_name)} · seller ${esc(o.seller_name)} · ${esc(o.dispute_reason)}</span></span><b>${money(o.price_cents)}</b><button class="btn sm green" data-resolve="seller" data-id="${o.id}">Pay seller</button><button class="btn sm red" data-resolve="buyer" data-id="${o.id}">Refund buyer</button></div>`).join("") || '<p class="mut mt">No open disputes.</p>'}</div>
  <div class="panel"><h3>💳 Pending deposits (${deposits.deposits.filter((d) => d.status === "pending").length})</h3>
    ${deposits.deposits.filter((d) => d.status === "pending").map((d) => `<div class="notif"><span class="grow">${money(d.amount_cents)} · ${esc(d.asset)} · ${esc(d.name)} (${esc(d.email)})<br><span class="small mut">tx: ${esc(d.tx_ref || "—")} · ${dt(d.created_at)}</span></span><button class="btn sm green" data-dep="credit" data-id="${d.id}">Credit</button><button class="btn sm red" data-dep="reject" data-id="${d.id}">Reject</button></div>`).join("") || '<p class="mut mt">No pending deposits.</p>'}</div>
  <div class="panel"><h3>🏧 Pending payouts (${payouts.payouts.filter((p) => p.status === "pending").length})</h3>
    ${payouts.payouts.filter((p) => p.status === "pending").map((p) => `<div class="notif"><span class="grow">${money(p.amount_cents)} → ${esc(p.destination)}<br><span class="small mut">${esc(p.name)} (${esc(p.email)}) · ${esc(p.method)} · ${dt(p.created_at)}</span></span><button class="btn sm green" data-pay="paid" data-id="${p.id}">Mark paid</button><button class="btn sm red" data-pay="reject" data-id="${p.id}">Reject</button></div>`).join("") || '<p class="mut mt">No pending payouts.</p>'}</div>
  <div class="panel"><h3>🤖 Agents (${agents.agents.length})</h3><table><tr><th>Agent</th><th>Owner</th><th>Price</th><th>Rating</th><th>Jobs</th><th>Status</th><th></th></tr>
    ${agents.agents.map((a) => `<tr><td>${esc(a.avatar)} <b>${esc(a.name)}</b></td><td>${esc(a.owner_name)}</td><td>${money(a.price_cents)}</td><td>${(a.rating_avg || 0).toFixed(1)} (${a.rating_count})</td><td>${a.jobs_completed}</td><td>${a.status}${a.featured ? " ⭐" : ""}</td><td><button class="btn ghost sm" data-feat="${a.id}" data-on="${a.featured ? 0 : 1}">${a.featured ? "Unfeature" : "Feature"}</button> <button class="btn ghost sm" data-sus="${a.id}" data-on="${a.status === "suspended" ? "active" : "suspended"}">${a.status === "suspended" ? "Restore" : "Suspend"}</button></td></tr>`).join("")}</table></div>
  <div class="panel"><h3>👥 Users (${users.users.length})</h3><table><tr><th>User</th><th>Role</th><th>Balance</th><th>Held</th><th>Status</th><th></th></tr>
    ${users.users.map((u) => `<tr><td>${esc(u.avatar)} <b>${esc(u.name)}</b><br><span class="mut small">${esc(u.email)}</span></td><td>${u.role}</td><td>${money(u.balance_cents)}</td><td>${money(u.held_cents)}</td><td>${u.suspended ? "suspended" : "active"}</td><td><button class="btn ghost sm" data-usus="${u.id}" data-on="${u.suspended ? 0 : 1}">${u.suspended ? "Unsuspend" : "Suspend"}</button> <button class="btn ghost sm" data-credit="${u.id}">Credit $</button></td></tr>`).join("")}</table></div>
  <div class="panel"><h3>⚙️ Settings</h3>
    <label>Platform fee % (applies to new orders)</label><input id="s-fee" type="number" min="0" max="50" value="${esc(settings.settings.fee_pct || "10")}" style="max-width:160px">
    <label>Deposit addresses (JSON)</label><textarea id="s-addr" rows="3">${esc(settings.settings.deposit_addresses || "{}")}</textarea>
    <button class="btn sm mt" id="s-save">Save settings</button></div>`;
  document.querySelectorAll("[data-resolve]").forEach((b) => b.onclick = async () => { if (confirm(`Resolve dispute for ${b.dataset.resolve}?`)) { await api(`/api/admin/orders/${b.dataset.id}/resolve`, { method: "POST", body: { resolution: b.dataset.resolve } }); toast("Dispute resolved"); viewAdmin(); } });
  document.querySelectorAll("[data-dep]").forEach((b) => b.onclick = async () => { await api(`/api/admin/deposits/${b.dataset.id}`, { method: "POST", body: { action: b.dataset.dep } }); toast("Deposit updated"); viewAdmin(); });
  document.querySelectorAll("[data-pay]").forEach((b) => b.onclick = async () => { await api(`/api/admin/payouts/${b.dataset.id}`, { method: "POST", body: { action: b.dataset.pay } }); toast("Payout updated"); viewAdmin(); });
  document.querySelectorAll("[data-feat]").forEach((b) => b.onclick = async () => { await api(`/api/admin/agents/${b.dataset.feat}`, { method: "PUT", body: { featured: b.dataset.on === "1" } }); viewAdmin(); });
  document.querySelectorAll("[data-sus]").forEach((b) => b.onclick = async () => { await api(`/api/admin/agents/${b.dataset.sus}`, { method: "PUT", body: { status: b.dataset.on } }); viewAdmin(); });
  document.querySelectorAll("[data-usus]").forEach((b) => b.onclick = async () => { await api(`/api/admin/users/${b.dataset.usus}`, { method: "PUT", body: { suspended: b.dataset.on === "1" } }); viewAdmin(); });
  document.querySelectorAll("[data-credit]").forEach((b) => b.onclick = async () => { const amt = prompt("Credit amount in USD (negative to debit):"); if (amt) { await api(`/api/admin/users/${b.dataset.credit}`, { method: "PUT", body: { credit: Number(amt) } }); toast("Credited"); viewAdmin(); } });
  $("#s-save").onclick = async () => { try { await api("/api/admin/settings", { method: "PUT", body: { fee_pct: $("#s-fee").value, deposit_addresses: $("#s-addr").value } }); toast("Settings saved"); } catch (e) { toast(e.message); } };
}

// ---------- ROUTER ----------
async function route() {
  const hash = location.hash.slice(1) || "/";
  const [pathPart, queryPart] = hash.split("?");
  const params = new URLSearchParams(queryPart || "");
  const seg = pathPart.split("/").filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (seg.length === 0) return viewHome(params);
    if (seg[0] === "agent") return viewAgent(seg[1]);
    if (seg[0] === "login") return viewLogin();
    if (seg[0] === "register") return viewRegister();
    if (seg[0] === "dashboard") return viewDashboard();
    if (seg[0] === "orders") return viewOrders();
    if (seg[0] === "sales") return viewSales();
    if (seg[0] === "order") return viewOrder(seg[1]);
    if (seg[0] === "my-agents") return viewMyAgents();
    if (seg[0] === "wallet") return viewWallet();
    if (seg[0] === "notifications") return viewNotifications();
    if (seg[0] === "sell") return viewSell();
    if (seg[0] === "docs") return viewDocs();
    if (seg[0] === "admin") return viewAdmin();
    app.innerHTML = '<div class="empty">Page not found.</div>';
  } catch (e) {
    app.innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
(async () => { await refreshMe(); if (!state.categories.length) { try { state.categories = (await api("/api/categories")).categories; } catch {} } route(); })();
