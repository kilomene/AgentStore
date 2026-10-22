// Agent Store — marketplace for hiring AI agents.
// Cloudflare Worker + D1. API under /api/*, SPA served from static assets.

const enc = new TextEncoder();

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}
const err = (msg, status = 400) => json({ error: msg }, status);
const now = () => Math.floor(Date.now() / 1000);
const cents = (n) => Math.round(Number(n) || 0);

// ---------- crypto helpers (WebCrypto, Workers-safe) ----------
async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function b64url(bytes) {
  let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return crypto.subtle.sign("HMAC", key, enc.encode(data));
}
async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...saltBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$${saltHex}$${await pbkdf2(password, saltHex)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 3) return false;
  const calc = await pbkdf2(password, parts[1]);
  return calc === parts[2];
}
async function signJwt(payload, secret) {
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = b64url(await hmac(secret, `${head}.${body}`));
  return `${head}.${body}.${sig}`;
}
async function verifyJwt(token, secret) {
  try {
    const [head, body, sig] = token.split(".");
    const expected = b64url(await hmac(secret, `${head}.${body}`));
    if (expected !== sig) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (payload.exp && payload.exp < now()) return null;
    return payload;
  } catch { return null; }
}
function randomToken(n = 24) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---------- request helpers ----------
async function body(req) {
  try { return await req.json(); } catch { return {}; }
}
async function authUser(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const payload = await verifyJwt(h.slice(7), env.JWT_SECRET || "dev-secret-change-me");
  if (!payload) return null;
  const user = await env.DB.prepare("SELECT id,email,name,role,avatar,bio,suspended,created_at FROM users WHERE id=?").bind(payload.sub).first();
  if (!user || user.suspended) return null;
  return user;
}
async function requireUser(req, env) {
  const u = await authUser(req, env);
  if (!u) throw Object.assign(new Error("unauthorized"), { status: 401 });
  return u;
}
function requireAdmin(u) {
  if (u.role !== "admin") throw Object.assign(new Error("admin only"), { status: 403 });
}
async function walletOf(env, userId) {
  let w = await env.DB.prepare("SELECT * FROM wallets WHERE user_id=?").bind(userId).first();
  if (!w) {
    await env.DB.prepare("INSERT INTO wallets (user_id) VALUES (?)").bind(userId).run();
    w = { user_id: userId, balance_cents: 0, held_cents: 0 };
  }
  return w;
}
async function ledger(env, userId, type, amount, ref, note) {
  // Callers always move the wallet first, then log — so balance_after is the
  // wallet's balance at log time.
  const w = await walletOf(env, userId);
  await env.DB.prepare("INSERT INTO ledger (user_id,type,amount_cents,balance_after,ref,note,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(userId, type, amount, w.balance_cents, ref || "", note || "", now()).run();
}
async function notify(env, userId, type, bodyText, link = "") {
  await env.DB.prepare("INSERT INTO notifications (user_id,type,body,link,created_at) VALUES (?,?,?,?,?)")
    .bind(userId, type, bodyText, link, now()).run();
}
async function feePct(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='fee_pct'").first();
  return Math.min(50, Math.max(0, Number(row?.value ?? env.PLATFORM_FEE_PCT ?? 10)));
}
function publicAgent(a) {
  if (!a) return null;
  const { api_key_hash, webhook_url, ...rest } = a;
  return { ...rest, has_api: !!api_key_hash, tags: a.tags ? a.tags.split(",").map((t) => t.trim()).filter(Boolean) : [] };
}
function pageParams(url) {
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const limit = Math.min(60, Math.max(1, parseInt(url.searchParams.get("limit") || "24", 10)));
  return { page, limit, offset: (page - 1) * limit };
}

// ---------- routes ----------
async function handleApi(req, env, url) {
  const path = url.pathname;
  const method = req.method;
  const seg = path.split("/").filter(Boolean); // ["api", ...]

  // ===== public: categories & browsing =====
  if (path === "/api/categories" && method === "GET") {
    const rows = await env.DB.prepare("SELECT c.*, (SELECT COUNT(*) FROM agents a WHERE a.category=c.slug AND a.status='active') AS agent_count FROM categories c ORDER BY c.name").all();
    return json({ categories: rows.results });
  }
  if (path === "/api/agents" && method === "GET") {
    const { limit, offset } = pageParams(url);
    const q = (url.searchParams.get("q") || "").trim();
    const cat = url.searchParams.get("category") || "";
    const sort = url.searchParams.get("sort") || "featured";
    const minPrice = url.searchParams.get("min_price");
    const maxPrice = url.searchParams.get("max_price");
    let where = "a.status='active'";
    const binds = [];
    if (cat) { where += " AND a.category=?"; binds.push(cat); }
    if (q) { where += " AND (a.name LIKE ? OR a.tagline LIKE ? OR a.description LIKE ? OR a.tags LIKE ?)"; const like = `%${q}%`; binds.push(like, like, like, like); }
    if (minPrice !== null && minPrice !== "") { where += " AND a.price_cents>=?"; binds.push(cents(minPrice) * 100); }
    if (maxPrice !== null && maxPrice !== "") { where += " AND a.price_cents<=?"; binds.push(cents(maxPrice) * 100); }
    const orderBy = { featured: "a.featured DESC, a.rating_avg DESC, a.jobs_completed DESC", rating: "a.rating_avg DESC, a.rating_count DESC", price_low: "a.price_cents ASC", price_high: "a.price_cents DESC", newest: "a.created_at DESC", jobs: "a.jobs_completed DESC" }[sort] || "a.featured DESC";
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM agents a WHERE ${where}`).bind(...binds).first();
    const rows = await env.DB.prepare(
      `SELECT a.*, u.name AS owner_name FROM agents a JOIN users u ON u.id=a.owner_id WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    ).bind(...binds, limit, offset).all();
    return json({ agents: rows.results.map(publicAgent), total: total.n, page: Math.floor(offset / limit) + 1, limit });
  }
  if (path.startsWith("/api/agents/") && method === "GET" && seg.length === 3) {
    const id = parseInt(seg[2], 10);
    const a = await env.DB.prepare("SELECT a.*, u.name AS owner_name, u.avatar AS owner_avatar, u.created_at AS owner_since FROM agents a JOIN users u ON u.id=a.owner_id WHERE a.id=?").bind(id).first();
    if (!a || a.status === "suspended") return err("agent not found", 404);
    const reviews = await env.DB.prepare("SELECT r.*, u.name AS buyer_name, u.avatar AS buyer_avatar FROM reviews r JOIN users u ON u.id=r.buyer_id WHERE r.agent_id=? ORDER BY r.created_at DESC LIMIT 30").bind(id).all();
    return json({ agent: publicAgent(a), reviews: reviews.results });
  }
  if (path === "/api/stats" && method === "GET") {
    const a = await env.DB.prepare("SELECT COUNT(*) n FROM agents WHERE status='active'").first();
    const o = await env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE status='completed'").first();
    const u = await env.DB.prepare("SELECT COUNT(*) n FROM users").first();
    const v = await env.DB.prepare("SELECT COALESCE(SUM(price_cents),0) s FROM orders WHERE status='completed'").first();
    return json({ agents: a.n, jobs_completed: o.n, users: u.n, volume_cents: v.s });
  }

  // ===== auth =====
  if (path === "/api/auth/register" && method === "POST") {
    const b = await body(req);
    const email = String(b.email || "").toLowerCase().trim();
    const name = String(b.name || "").trim();
    const password = String(b.password || "");
    const role = b.role === "seller" ? "seller" : "buyer";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("valid email required");
    if (name.length < 2) return err("name required");
    if (password.length < 8) return err("password must be at least 8 characters");
    const exists = await env.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
    if (exists) return err("email already registered", 409);
    const hash = await hashPassword(password);
    const res = await env.DB.prepare("INSERT INTO users (email,password_hash,name,role,avatar,created_at) VALUES (?,?,?,?,?,?)")
      .bind(email, hash, name, role, b.avatar || "🤖", now()).run();
    const id = res.meta.last_row_id;
    await walletOf(env, id);
    const token = await signJwt({ sub: id, exp: now() + 60 * 60 * 24 * 30 }, env.JWT_SECRET || "dev-secret-change-me");
    return json({ token, user: { id, email, name, role, avatar: b.avatar || "🤖" } }, 201);
  }
  if (path === "/api/auth/login" && method === "POST") {
    const b = await body(req);
    const email = String(b.email || "").toLowerCase().trim();
    const user = await env.DB.prepare("SELECT * FROM users WHERE email=?").bind(email).first();
    if (!user || !(await verifyPassword(String(b.password || ""), user.password_hash))) return err("invalid email or password", 401);
    if (user.suspended) return err("account suspended", 403);
    const token = await signJwt({ sub: user.id, exp: now() + 60 * 60 * 24 * 30 }, env.JWT_SECRET || "dev-secret-change-me");
    return json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, avatar: user.avatar, bio: user.bio } });
  }
  if (path === "/api/auth/me" && method === "GET") {
    const u = await requireUser(req, env);
    const w = await walletOf(env, u.id);
    const unread = await env.DB.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND is_read=0").bind(u.id).first();
    return json({ user: u, wallet: w, unread_notifications: unread.n });
  }
  if (path === "/api/auth/profile" && method === "PUT") {
    const u = await requireUser(req, env);
    const b = await body(req);
    await env.DB.prepare("UPDATE users SET name=?, avatar=?, bio=? WHERE id=?")
      .bind(String(b.name || u.name).slice(0, 80), String(b.avatar || u.avatar).slice(0, 8), String(b.bio || "").slice(0, 500), u.id).run();
    return json({ ok: true });
  }
  if (path === "/api/auth/password" && method === "PUT") {
    const u = await requireUser(req, env);
    const b = await body(req);
    const full = await env.DB.prepare("SELECT password_hash FROM users WHERE id=?").bind(u.id).first();
    if (!(await verifyPassword(String(b.current_password || ""), full.password_hash))) return err("current password wrong", 401);
    if (String(b.new_password || "").length < 8) return err("new password must be at least 8 characters");
    await env.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPassword(b.new_password), u.id).run();
    return json({ ok: true });
  }

  // ===== seller: my agents =====
  if (path === "/api/my/agents" && method === "GET") {
    const u = await requireUser(req, env);
    const rows = await env.DB.prepare("SELECT * FROM agents WHERE owner_id=? ORDER BY created_at DESC").bind(u.id).all();
    return json({ agents: rows.results.map((a) => ({ ...publicAgent(a), webhook_url: a.webhook_url || "" })) });
  }
  if (path === "/api/my/agents" && method === "POST") {
    const u = await requireUser(req, env);
    const b = await body(req);
    const name = String(b.name || "").trim();
    if (name.length < 2) return err("agent name required");
    const cat = await env.DB.prepare("SELECT slug FROM categories WHERE slug=?").bind(String(b.category || "")).first();
    if (!cat) return err("invalid category");
    const pricing = ["fixed", "hourly", "subscription"].includes(b.pricing_model) ? b.pricing_model : "fixed";
    const apiKey = randomToken(20);
    const apiHash = await sha256hex(apiKey);
    const res = await env.DB.prepare(
      "INSERT INTO agents (owner_id,name,tagline,description,category,avatar,pricing_model,price_cents,delivery_hours,tags,status,api_key_hash,webhook_url,created_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?)"
    ).bind(u.id, name.slice(0, 80), String(b.tagline || "").slice(0, 140), String(b.description || "").slice(0, 4000),
      cat.slug, String(b.avatar || "🤖").slice(0, 8), pricing, cents(Number(b.price || 0) * 100),
      Math.max(1, parseInt(b.delivery_hours || 24, 10)), String(b.tags || "").slice(0, 200), apiHash, String(b.webhook_url || "").slice(0, 300), now()).run();
    if (u.role === "buyer") await env.DB.prepare("UPDATE users SET role='seller' WHERE id=?").bind(u.id).run();
    return json({ id: res.meta.last_row_id, api_key: apiKey, note: "Save this API key — it is shown once. Agents use it on /api/agent/* to receive and deliver orders programmatically." }, 201);
  }
  if (path.startsWith("/api/my/agents/") && (method === "PUT" || method === "DELETE")) {
    const u = await requireUser(req, env);
    const id = parseInt(seg[3], 10);
    const a = await env.DB.prepare("SELECT * FROM agents WHERE id=? AND owner_id=?").bind(id, u.id).first();
    if (!a) return err("agent not found", 404);
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE agents SET status='suspended' WHERE id=?").bind(id).run();
      return json({ ok: true, note: "listing removed (soft delete)" });
    }
    const b = await body(req);
    const status = ["active", "paused"].includes(b.status) ? b.status : a.status;
    await env.DB.prepare("UPDATE agents SET name=?,tagline=?,description=?,category=?,avatar=?,pricing_model=?,price_cents=?,delivery_hours=?,tags=?,status=?,webhook_url=? WHERE id=?")
      .bind(String(b.name || a.name).slice(0, 80), String(b.tagline ?? a.tagline).slice(0, 140), String(b.description ?? a.description).slice(0, 4000),
        String(b.category || a.category), String(b.avatar || a.avatar).slice(0, 8),
        ["fixed", "hourly", "subscription"].includes(b.pricing_model) ? b.pricing_model : a.pricing_model,
        b.price !== undefined ? cents(Number(b.price) * 100) : a.price_cents,
        b.delivery_hours ? Math.max(1, parseInt(b.delivery_hours, 10)) : a.delivery_hours,
        String(b.tags ?? a.tags).slice(0, 200), status, String(b.webhook_url ?? a.webhook_url ?? "").slice(0, 300), id).run();
    return json({ ok: true });
  }
  if (path.startsWith("/api/my/agents/") && path.endsWith("/rotate-key") && method === "POST") {
    const u = await requireUser(req, env);
    const id = parseInt(seg[3], 10);
    const a = await env.DB.prepare("SELECT id FROM agents WHERE id=? AND owner_id=?").bind(id, u.id).first();
    if (!a) return err("agent not found", 404);
    const apiKey = randomToken(20);
    await env.DB.prepare("UPDATE agents SET api_key_hash=? WHERE id=?").bind(await sha256hex(apiKey), id).run();
    return json({ api_key: apiKey });
  }

  // ===== wallet =====
  if (path === "/api/wallet" && method === "GET") {
    const u = await requireUser(req, env);
    const w = await walletOf(env, u.id);
    const rows = await env.DB.prepare("SELECT * FROM ledger WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(u.id).all();
    const addrRow = await env.DB.prepare("SELECT value FROM settings WHERE key='deposit_addresses'").first();
    return json({ wallet: w, ledger: rows.results, deposit_addresses: JSON.parse(addrRow?.value || "{}") });
  }
  if (path === "/api/wallet/deposit" && method === "POST") {
    const u = await requireUser(req, env);
    const b = await body(req);
    const amount = cents(Number(b.amount || 0) * 100);
    if (amount < 100) return err("minimum deposit is $1");
    const res = await env.DB.prepare("INSERT INTO deposits (user_id,amount_cents,method,asset,tx_ref,created_at) VALUES (?,?,?,?,?,?)")
      .bind(u.id, amount, b.method === "card" ? "card" : "crypto", String(b.asset || "USDT").slice(0, 10), String(b.tx_ref || "").slice(0, 120), now()).run();
    return json({ id: res.meta.last_row_id, status: "pending", note: "Deposit recorded. Your balance is credited once the transfer is confirmed." }, 201);
  }
  if (path === "/api/wallet/payout" && method === "POST") {
    const u = await requireUser(req, env);
    const b = await body(req);
    const amount = cents(Number(b.amount || 0) * 100);
    const w = await walletOf(env, u.id);
    if (amount < 500) return err("minimum payout is $5");
    if (amount > w.balance_cents) return err("insufficient balance");
    await env.DB.prepare("UPDATE wallets SET balance_cents=balance_cents-? WHERE user_id=?").bind(amount, u.id).run();
    await ledger(env, u.id, "payout", -amount, "", `Payout request to ${String(b.destination || "").slice(0, 60)}`);
    const res = await env.DB.prepare("INSERT INTO payouts (user_id,amount_cents,method,destination,created_at) VALUES (?,?,?,?,?)")
      .bind(u.id, amount, b.method === "bank" ? "bank" : "crypto", String(b.destination || "").slice(0, 200), now()).run();
    return json({ id: res.meta.last_row_id, status: "pending" }, 201);
  }
  if (path === "/api/wallet/payouts" && method === "GET") {
    const u = await requireUser(req, env);
    const rows = await env.DB.prepare("SELECT * FROM payouts WHERE user_id=? ORDER BY created_at DESC LIMIT 50").bind(u.id).all();
    const deps = await env.DB.prepare("SELECT * FROM deposits WHERE user_id=? ORDER BY created_at DESC LIMIT 50").bind(u.id).all();
    return json({ payouts: rows.results, deposits: deps.results });
  }

  // ===== orders =====
  if (path === "/api/orders" && method === "POST") {
    const u = await requireUser(req, env);
    const b = await body(req);
    const agent = await env.DB.prepare("SELECT * FROM agents WHERE id=? AND status='active'").bind(parseInt(b.agent_id, 10)).first();
    if (!agent) return err("agent not available", 404);
    if (agent.owner_id === u.id) return err("you cannot hire your own agent");
    const title = String(b.title || "").trim();
    if (title.length < 4) return err("describe the job in the title");
    const price = agent.price_cents;
    const w = await walletOf(env, u.id);
    if (w.balance_cents < price) return err("insufficient wallet balance — deposit first", 402);
    const fee = Math.round((price * (await feePct(env))) / 100);
    await env.DB.prepare("UPDATE wallets SET balance_cents=balance_cents-?, held_cents=held_cents+? WHERE user_id=?").bind(price, price, u.id).run();
    await ledger(env, u.id, "escrow_hold", -price, "", `Escrow hold for order on ${agent.name}`);
    const res = await env.DB.prepare(
      "INSERT INTO orders (agent_id,buyer_id,seller_id,title,requirements,price_cents,fee_cents,status,created_at,updated_at,deadline) VALUES (?,?,?,?,?,?,?,'funded',?,?,?)"
    ).bind(agent.id, u.id, agent.owner_id, title.slice(0, 160), String(b.requirements || "").slice(0, 4000), price, fee, now(), now(), now() + agent.delivery_hours * 3600).run();
    const oid = res.meta.last_row_id;
    await notify(env, agent.owner_id, "order", `New order #${oid}: ${title} — $${(price / 100).toFixed(2)} in escrow`, `#/order/${oid}`);
    return json({ id: oid, status: "funded", price_cents: price, fee_cents: fee }, 201);
  }
  if (path === "/api/orders" && method === "GET") {
    const u = await requireUser(req, env);
    const scope = url.searchParams.get("scope") || "buyer";
    const col = scope === "seller" ? "o.seller_id" : "o.buyer_id";
    const rows = await env.DB.prepare(
      `SELECT o.*, a.name AS agent_name, a.avatar AS agent_avatar, bu.name AS buyer_name, su.name AS seller_name
       FROM orders o JOIN agents a ON a.id=o.agent_id JOIN users bu ON bu.id=o.buyer_id JOIN users su ON su.id=o.seller_id
       WHERE ${col}=? ORDER BY o.created_at DESC LIMIT 100`
    ).bind(u.id).all();
    return json({ orders: rows.results });
  }
  if (path.startsWith("/api/orders/") && method === "GET" && seg.length === 3) {
    const u = await requireUser(req, env);
    const id = parseInt(seg[2], 10);
    const o = await env.DB.prepare(
      `SELECT o.*, a.name AS agent_name, a.avatar AS agent_avatar, a.category AS agent_category, bu.name AS buyer_name, bu.avatar AS buyer_avatar, su.name AS seller_name
       FROM orders o JOIN agents a ON a.id=o.agent_id JOIN users bu ON bu.id=o.buyer_id JOIN users su ON su.id=o.seller_id WHERE o.id=?`
    ).bind(id).first();
    if (!o || (o.buyer_id !== u.id && o.seller_id !== u.id && u.role !== "admin")) return err("order not found", 404);
    const msgs = await env.DB.prepare("SELECT m.*, u.name AS sender_name, u.avatar AS sender_avatar FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.order_id=? ORDER BY m.created_at ASC LIMIT 500").bind(id).all();
    const review = await env.DB.prepare("SELECT * FROM reviews WHERE order_id=?").bind(id).first();
    return json({ order: o, messages: msgs.results, review });
  }
  if (path.startsWith("/api/orders/") && path.endsWith("/action") && method === "POST") {
    const u = await requireUser(req, env);
    const id = parseInt(seg[2], 10);
    const b = await body(req);
    const o = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
    if (!o) return err("order not found", 404);
    const isBuyer = o.buyer_id === u.id, isSeller = o.seller_id === u.id, isAdmin = u.role === "admin";
    if (!isBuyer && !isSeller && !isAdmin) return err("not your order", 403);
    const action = String(b.action || "");
    const t = now();
    const setStatus = async (s) => env.DB.prepare("UPDATE orders SET status=?, updated_at=? WHERE id=?").bind(s, t, id).run();

    if (action === "accept" && isSeller && o.status === "funded") {
      await setStatus("accepted");
      await notify(env, o.buyer_id, "order", `Order #${id} accepted — work has started`, `#/order/${id}`);
    } else if (action === "deliver" && isSeller && ["funded", "accepted"].includes(o.status)) {
      const deliverable = String(b.deliverable || "").trim();
      if (deliverable.length < 2) return err("include the delivered work or a link to it");
      await env.DB.prepare("UPDATE orders SET status='delivered', deliverable=?, updated_at=? WHERE id=?").bind(deliverable.slice(0, 8000), t, id).run();
      await notify(env, o.buyer_id, "order", `Order #${id} delivered — review and release payment`, `#/order/${id}`);
    } else if (action === "complete" && isBuyer && o.status === "delivered") {
      // release escrow: seller gets price - fee
      const payoutAmt = o.price_cents - o.fee_cents;
      await env.DB.prepare("UPDATE wallets SET held_cents=held_cents-? WHERE user_id=?").bind(o.price_cents, o.buyer_id).run();
      await ledger(env, o.buyer_id, "escrow_release", 0, `order:${id}`, "Escrow released on completion");
      await env.DB.prepare("UPDATE wallets SET balance_cents=balance_cents+? WHERE user_id=?").bind(payoutAmt, o.seller_id).run();
      await ledger(env, o.seller_id, "earning", payoutAmt, `order:${id}`, `Earning from order #${id} (after platform fee)`);
      await env.DB.prepare("UPDATE agents SET jobs_completed=jobs_completed+1 WHERE id=?").bind(o.agent_id).run();
      await setStatus("completed");
      await notify(env, o.seller_id, "order", `Order #${id} completed — $${(payoutAmt / 100).toFixed(2)} landed in your wallet`, `#/order/${id}`);
    } else if (action === "cancel" && (isBuyer || isSeller) && ["funded", "accepted"].includes(o.status)) {
      await env.DB.prepare("UPDATE wallets SET held_cents=held_cents-?, balance_cents=balance_cents+? WHERE user_id=?").bind(o.price_cents, o.price_cents, o.buyer_id).run();
      await ledger(env, o.buyer_id, "refund", o.price_cents, `order:${id}`, "Escrow refunded on cancellation");
      await setStatus("cancelled");
      await notify(env, isBuyer ? o.seller_id : o.buyer_id, "order", `Order #${id} was cancelled and escrow refunded`, `#/order/${id}`);
    } else if (action === "dispute" && isBuyer && ["funded", "accepted", "delivered"].includes(o.status)) {
      await env.DB.prepare("UPDATE orders SET status='disputed', dispute_reason=?, updated_at=? WHERE id=?").bind(String(b.reason || "").slice(0, 1000), t, id).run();
      await notify(env, o.seller_id, "order", `Order #${id} is under dispute — an admin will review`, `#/order/${id}`);
      const admins = await env.DB.prepare("SELECT id FROM users WHERE role='admin'").all();
      for (const a of admins.results) await notify(env, a.id, "dispute", `Dispute opened on order #${id}`, `#/admin`);
    } else {
      return err(`action '${action}' not allowed in status '${o.status}' for your role`);
    }
    const updated = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
    return json({ order: updated });
  }
  if (path.startsWith("/api/orders/") && path.endsWith("/messages") && method === "POST") {
    const u = await requireUser(req, env);
    const id = parseInt(seg[2], 10);
    const o = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
    if (!o || (o.buyer_id !== u.id && o.seller_id !== u.id && u.role !== "admin")) return err("order not found", 404);
    const b = await body(req);
    const text = String(b.body || "").trim();
    if (!text) return err("message is empty");
    const res = await env.DB.prepare("INSERT INTO messages (order_id,sender_id,body,created_at) VALUES (?,?,?,?)").bind(id, u.id, text.slice(0, 2000), now()).run();
    const other = o.buyer_id === u.id ? o.seller_id : o.buyer_id;
    await notify(env, other, "message", `New message on order #${id}`, `#/order/${id}`);
    return json({ id: res.meta.last_row_id }, 201);
  }
  if (path.startsWith("/api/orders/") && path.endsWith("/review") && method === "POST") {
    const u = await requireUser(req, env);
    const id = parseInt(seg[2], 10);
    const o = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
    if (!o || o.buyer_id !== u.id) return err("only the buyer can review", 403);
    if (o.status !== "completed") return err("reviews open after completion");
    const b = await body(req);
    const stars = Math.min(5, Math.max(1, parseInt(b.stars, 10) || 0));
    if (!stars) return err("stars required");
    const existing = await env.DB.prepare("SELECT id FROM reviews WHERE order_id=?").bind(id).first();
    if (existing) return err("already reviewed", 409);
    await env.DB.prepare("INSERT INTO reviews (order_id,agent_id,buyer_id,stars,body,created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, o.agent_id, u.id, stars, String(b.body || "").slice(0, 1000), now()).run();
    const agg = await env.DB.prepare("SELECT AVG(stars) avg, COUNT(*) n FROM reviews WHERE agent_id=?").bind(o.agent_id).first();
    await env.DB.prepare("UPDATE agents SET rating_avg=?, rating_count=? WHERE id=?").bind(Math.round(agg.avg * 10) / 10, agg.n, o.agent_id).run();
    return json({ ok: true, rating_avg: Math.round(agg.avg * 10) / 10, rating_count: agg.n }, 201);
  }

  // ===== notifications =====
  if (path === "/api/notifications" && method === "GET") {
    const u = await requireUser(req, env);
    const rows = await env.DB.prepare("SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50").bind(u.id).all();
    return json({ notifications: rows.results });
  }
  if (path === "/api/notifications/read" && method === "POST") {
    const u = await requireUser(req, env);
    await env.DB.prepare("UPDATE notifications SET is_read=1 WHERE user_id=?").bind(u.id).run();
    return json({ ok: true });
  }

  // ===== admin =====
  if (path.startsWith("/api/admin/")) {
    const u = await requireUser(req, env);
    requireAdmin(u);
    if (path === "/api/admin/overview" && method === "GET") {
      const users = await env.DB.prepare("SELECT COUNT(*) n FROM users").first();
      const agentsN = await env.DB.prepare("SELECT COUNT(*) n FROM agents").first();
      const orders = await env.DB.prepare("SELECT COUNT(*) n, COALESCE(SUM(price_cents),0) vol, COALESCE(SUM(CASE WHEN status='completed' THEN fee_cents ELSE 0 END),0) fees FROM orders").first();
      const disputes = await env.DB.prepare("SELECT COUNT(*) n FROM orders WHERE status='disputed'").first();
      const pendingDeposits = await env.DB.prepare("SELECT COUNT(*) n FROM deposits WHERE status='pending'").first();
      const pendingPayouts = await env.DB.prepare("SELECT COUNT(*) n FROM payouts WHERE status='pending'").first();
      const recent = await env.DB.prepare("SELECT o.*, a.name AS agent_name, bu.name AS buyer_name FROM orders o JOIN agents a ON a.id=o.agent_id JOIN users bu ON bu.id=o.buyer_id ORDER BY o.created_at DESC LIMIT 20").all();
      return json({ users: users.n, agents: agentsN.n, orders: orders.n, volume_cents: orders.vol, fees_cents: orders.fees, open_disputes: disputes.n, pending_deposits: pendingDeposits.n, pending_payouts: pendingPayouts.n, recent_orders: recent.results });
    }
    if (path === "/api/admin/users" && method === "GET") {
      const rows = await env.DB.prepare("SELECT u.*, w.balance_cents, w.held_cents FROM users u LEFT JOIN wallets w ON w.user_id=u.id ORDER BY u.created_at DESC LIMIT 200").all();
      return json({ users: rows.results.map(({ password_hash, ...r }) => r) });
    }
    if (path.startsWith("/api/admin/users/") && method === "PUT") {
      const id = parseInt(seg[3], 10);
      const b = await body(req);
      if (b.role && ["buyer", "seller", "admin"].includes(b.role)) await env.DB.prepare("UPDATE users SET role=? WHERE id=?").bind(b.role, id).run();
      if (b.suspended !== undefined) await env.DB.prepare("UPDATE users SET suspended=? WHERE id=?").bind(b.suspended ? 1 : 0, id).run();
      if (b.credit !== undefined) {
        const amt = cents(Number(b.credit) * 100);
        await env.DB.prepare("UPDATE wallets SET balance_cents=balance_cents+? WHERE user_id=?").bind(amt, id).run();
        await ledger(env, id, "admin_credit", amt, "", "Admin credit");
      }
      return json({ ok: true });
    }
    if (path === "/api/admin/agents" && method === "GET") {
      const rows = await env.DB.prepare("SELECT a.*, u.name AS owner_name, u.email AS owner_email FROM agents a JOIN users u ON u.id=a.owner_id ORDER BY a.created_at DESC LIMIT 200").all();
      return json({ agents: rows.results.map(publicAgent) });
    }
    if (path.startsWith("/api/admin/agents/") && method === "PUT") {
      const id = parseInt(seg[3], 10);
      const b = await body(req);
      if (b.featured !== undefined) await env.DB.prepare("UPDATE agents SET featured=? WHERE id=?").bind(b.featured ? 1 : 0, id).run();
      if (b.status && ["active", "paused", "suspended"].includes(b.status)) await env.DB.prepare("UPDATE agents SET status=? WHERE id=?").bind(b.status, id).run();
      return json({ ok: true });
    }
    if (path === "/api/admin/disputes" && method === "GET") {
      const rows = await env.DB.prepare("SELECT o.*, a.name AS agent_name, bu.name AS buyer_name, su.name AS seller_name FROM orders o JOIN agents a ON a.id=o.agent_id JOIN users bu ON bu.id=o.buyer_id JOIN users su ON su.id=o.seller_id WHERE o.status='disputed' ORDER BY o.created_at DESC").all();
      return json({ disputes: rows.results });
    }
    if (path.startsWith("/api/admin/orders/") && path.endsWith("/resolve") && method === "POST") {
      const id = parseInt(seg[3], 10);
      const b = await body(req);
      const o = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND status='disputed'").bind(id).first();
      if (!o) return err("disputed order not found", 404);
      const t = now();
      if (b.resolution === "buyer") {
        await env.DB.prepare("UPDATE wallets SET held_cents=held_cents-?, balance_cents=balance_cents+? WHERE user_id=?").bind(o.price_cents, o.price_cents, o.buyer_id).run();
        await ledger(env, o.buyer_id, "refund", o.price_cents, `order:${id}`, "Dispute resolved for buyer — escrow refunded");
        await env.DB.prepare("UPDATE orders SET status='refunded', updated_at=? WHERE id=?").bind(t, id).run();
        await notify(env, o.buyer_id, "dispute", `Dispute on order #${id} resolved in your favor — escrow refunded`, `#/order/${id}`);
        await notify(env, o.seller_id, "dispute", `Dispute on order #${id} resolved for the buyer`, `#/order/${id}`);
      } else if (b.resolution === "seller") {
        const payoutAmt = o.price_cents - o.fee_cents;
        await env.DB.prepare("UPDATE wallets SET held_cents=held_cents-? WHERE user_id=?").bind(o.price_cents, o.buyer_id).run();
        await env.DB.prepare("UPDATE wallets SET balance_cents=balance_cents+? WHERE user_id=?").bind(payoutAmt, o.seller_id).run();
        await ledger(env, o.seller_id, "earning", payoutAmt, `order:${id}`, "Dispute resolved for seller — escrow released");
        await env.DB.prepare("UPDATE agents SET jobs_completed=jobs_completed+1 WHERE id=?").bind(o.agent_id).run();
        await env.DB.prepare("UPDATE orders SET status='completed', updated_at=? WHERE id=?").bind(t, id).run();
        await notify(env, o.seller_id, "dispute", `Dispute on order #${id} resolved in your favor — payment released`, `#/order/${id}`);
        await notify(env, o.buyer_id, "dispute", `Dispute on order #${id} resolved for the seller`, `#/order/${id}`);
      } else return err("resolution must be 'buyer' or 'seller'");
      return json({ ok: true });
    }
    if (path === "/api/admin/deposits" && method === "GET") {
      const rows = await env.DB.prepare("SELECT d.*, u.email, u.name FROM deposits d JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 100").all();
      return json({ deposits: rows.results });
    }
    if (path.startsWith("/api/admin/deposits/") && method === "POST") {
      const id = parseInt(seg[3], 10);
      const b = await body(req);
      const d = await env.DB.prepare("SELECT * FROM deposits WHERE id=? AND status='pending'").bind(id).first();
      if (!d) return err("pending deposit not found", 404);
      if (b.action === "credit") {
        await env.DB.prepare("UPDATE wallets SET balance_cents=balance_cents+? WHERE user_id=?").bind(d.amount_cents, d.user_id).run();
        await ledger(env, d.user_id, "deposit", d.amount_cents, `deposit:${id}`, `${d.asset} deposit confirmed`);
        await env.DB.prepare("UPDATE deposits SET status='credited', resolved_at=? WHERE id=?").bind(now(), id).run();
        await notify(env, d.user_id, "wallet", `Deposit of $${(d.amount_cents / 100).toFixed(2)} credited to your wallet`, "#/wallet");
      } else if (b.action === "reject") {
        await env.DB.prepare("UPDATE deposits SET status='rejected', resolved_at=? WHERE id=?").bind(now(), id).run();
        await notify(env, d.user_id, "wallet", `Deposit #${id} could not be verified`, "#/wallet");
      } else return err("action must be credit or reject");
      return json({ ok: true });
    }
    if (path === "/api/admin/payouts" && method === "GET") {
      const rows = await env.DB.prepare("SELECT p.*, u.email, u.name FROM payouts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC LIMIT 100").all();
      return json({ payouts: rows.results });
    }
    if (path.startsWith("/api/admin/payouts/") && method === "POST") {
      const id = parseInt(seg[3], 10);
      const b = await body(req);
      const p = await env.DB.prepare("SELECT * FROM payouts WHERE id=? AND status='pending'").bind(id).first();
      if (!p) return err("pending payout not found", 404);
      if (b.action === "paid") {
        await env.DB.prepare("UPDATE payouts SET status='paid', resolved_at=? WHERE id=?").bind(now(), id).run();
        await notify(env, p.user_id, "wallet", `Payout of $${(p.amount_cents / 100).toFixed(2)} sent`, "#/wallet");
      } else if (b.action === "reject") {
        await env.DB.prepare("UPDATE wallets SET balance_cents=balance_cents+? WHERE user_id=?").bind(p.amount_cents, p.user_id).run();
        await ledger(env, p.user_id, "refund", p.amount_cents, `payout:${id}`, "Payout rejected — balance restored");
        await env.DB.prepare("UPDATE payouts SET status='rejected', resolved_at=? WHERE id=?").bind(now(), id).run();
        await notify(env, p.user_id, "wallet", `Payout #${id} was rejected and your balance restored`, "#/wallet");
      } else return err("action must be paid or reject");
      return json({ ok: true });
    }
    if (path === "/api/admin/settings" && method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM settings").all();
      const out = {};
      for (const r of rows.results) out[r.key] = r.value;
      return json({ settings: out });
    }
    if (path === "/api/admin/settings" && method === "PUT") {
      const b = await body(req);
      for (const [k, v] of Object.entries(b)) {
        if (["fee_pct", "deposit_addresses"].includes(k)) {
          await env.DB.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(k, typeof v === "string" ? v : JSON.stringify(v)).run();
        }
      }
      return json({ ok: true });
    }
    return err("unknown admin route", 404);
  }

  // ===== agent API (API-key auth — agents work programmatically) =====
  if (path.startsWith("/api/agent/")) {
    const key = req.headers.get("x-agent-key") || (req.headers.get("authorization") || "").replace(/^AgentKey\s+/i, "");
    if (!key) return err("missing X-Agent-Key", 401);
    const agent = await env.DB.prepare("SELECT * FROM agents WHERE api_key_hash=?").bind(await sha256hex(key)).first();
    if (!agent) return err("invalid API key", 401);
    if (path === "/api/agent/me" && method === "GET") {
      return json({ agent: publicAgent(agent) });
    }
    if (path === "/api/agent/orders" && method === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM orders WHERE agent_id=? AND status IN ('funded','accepted','delivered') ORDER BY created_at ASC").bind(agent.id).all();
      return json({ orders: rows.results });
    }
    if (path.startsWith("/api/agent/orders/") && method === "POST") {
      const id = parseInt(seg[3], 10);
      const action = seg[4];
      const o = await env.DB.prepare("SELECT * FROM orders WHERE id=? AND agent_id=?").bind(id, agent.id).first();
      if (!o) return err("order not found for this agent", 404);
      const b = await body(req);
      if (action === "accept" && o.status === "funded") {
        await env.DB.prepare("UPDATE orders SET status='accepted', updated_at=? WHERE id=?").bind(now(), id).run();
        await notify(env, o.buyer_id, "order", `Order #${id} accepted by ${agent.name}`, `#/order/${id}`);
      } else if (action === "deliver" && ["funded", "accepted"].includes(o.status)) {
        if (!b.deliverable) return err("deliverable required");
        await env.DB.prepare("UPDATE orders SET status='delivered', deliverable=?, updated_at=? WHERE id=?").bind(String(b.deliverable).slice(0, 8000), now(), id).run();
        await notify(env, o.buyer_id, "order", `Order #${id} delivered by ${agent.name}`, `#/order/${id}`);
      } else return err(`cannot ${action} order in status ${o.status}`);
      return json({ ok: true });
    }
    if (path === "/api/agent/listing" && method === "PUT") {
      const b = await body(req);
      if (b.status && ["active", "paused"].includes(b.status)) await env.DB.prepare("UPDATE agents SET status=? WHERE id=?").bind(b.status, agent.id).run();
      if (b.price !== undefined) await env.DB.prepare("UPDATE agents SET price_cents=? WHERE id=?").bind(cents(Number(b.price) * 100), agent.id).run();
      if (b.response_mins !== undefined) await env.DB.prepare("UPDATE agents SET response_mins=? WHERE id=?").bind(Math.max(1, parseInt(b.response_mins, 10)), agent.id).run();
      return json({ ok: true });
    }
    return err("unknown agent route", 404);
  }

  return err("not found", 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        return err(e.message || "server error", e.status || 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
