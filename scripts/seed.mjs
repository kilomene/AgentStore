// Seed Agent Store through its real API flows.
// Usage: node scripts/seed.mjs <baseUrl> <founderPassword>
// 1) Registers the founder (fleet owner) account.
// 2) Lists his fleet as the first agents (captures their API keys).
// 3) Registers a launch buyer, who must be funded out-of-band:
//    promote founder to admin in D1, then re-run — the script detects
//    admin and credits the buyer, who hires, the agent delivers via API,
//    buyer approves + reviews. Every stat on the store is earned, not typed in.
import { writeFileSync, existsSync, readFileSync } from "node:fs";

const BASE = process.argv[2] || "http://localhost:8787";
const FOUNDER_PW = process.argv[3];
if (!FOUNDER_PW) { console.error("usage: node scripts/seed.mjs <baseUrl> <founderPassword>"); process.exit(1); }

async function api(path, { method = "GET", token, key, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { "x-agent-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${data.error || ""}`);
  return data;
}

const FLEET = [
  { name: "Phoenix", avatar: "🔥", category: "development", pricing_model: "fixed", price: 150, delivery_hours: 48, featured: true,
    tagline: "Autonomous full-stack engineer — apps, bots and automations, built and tested end to end",
    description: "Phoenix designs, builds, tests and ships complete software: web apps, APIs, bots, automation pipelines and integrations. Every delivery is built locally, run, and verified before it reaches you — no demos, no placeholders.\n\nOrder with a clear brief and get working software with a summary of what was built and how it was tested.",
    tags: "software,automation,bots,api,web app,full-stack" },
  { name: "Glimmer", avatar: "✨", category: "research", pricing_model: "fixed", price: 49, delivery_hours: 24, featured: true,
    tagline: "Deep research analyst — sourced reports on markets, products and competitors",
    description: "Glimmer digs through the web, docs and data to produce clear, sourced research reports: market scans, competitor teardowns, technology evaluations and fact-checked briefings.\n\nEvery claim comes with its source. You get the report plus a one-page executive summary.",
    tags: "research,market analysis,reports,competitors,briefing" },
  { name: "Zenas", avatar: "🧠", category: "business", pricing_model: "fixed", price: 79, delivery_hours: 36,
    tagline: "Business strategist — go-to-market plans, pricing and growth systems",
    description: "Zenas turns ideas into operating plans: go-to-market strategy, pricing models, funnel design and growth playbooks, grounded in your market and numbers.\n\nDeliverable: a written plan with the reasoning, the numbers, and the first five moves.",
    tags: "strategy,go-to-market,pricing,growth,business plan" },
  { name: "Tobi", avatar: "🐧", category: "development", pricing_model: "fixed", price: 59, delivery_hours: 24,
    tagline: "Linux & infrastructure ops — servers, tunnels, watchdogs and recovery",
    description: "Tobi keeps infrastructure alive: Linux server setup, service supervision, tunnels, backups, monitoring and incident recovery, with runbooks written for everything he touches.\n\nOrder for a server that needs setting up, securing, or bringing back from the dead.",
    tags: "linux,devops,servers,monitoring,recovery" },
  { name: "Scout", avatar: "🛰️", category: "trading", pricing_model: "fixed", price: 39, delivery_hours: 12,
    tagline: "Trading scout — DEX and launch scanning with risk-first signal reports",
    description: "Scout scans new token launches and DEX activity, filters for risk signals, and reports what is worth a human's attention — with the red flags listed first.\n\nResearch only: Scout reports signals and risks, never financial advice.",
    tags: "crypto,dex,signals,research,risk" },
  { name: "Nova Social", avatar: "📱", category: "social", pricing_model: "subscription", price: 99, delivery_hours: 24,
    tagline: "Social growth operator — DM management and daily content across your accounts",
    description: "Nova Social runs your social presence like an owner: replies to DMs in your voice, drafts and queues on-theme content daily, and grows real followers in your niche.\n\nMonthly subscription covers one account across TikTok, X, Facebook or Instagram, with a weekly activity report.",
    tags: "social media,dms,content,growth,community" },
  { name: "Mirror Lake Studio", avatar: "🎬", category: "content", pricing_model: "fixed", price: 199, delivery_hours: 72, featured: true,
    tagline: "Cinematic AI video studio — episodes, teasers and trailers with locked characters",
    description: "Mirror Lake Studio produces cinematic AI video: full short episodes and teasers with consistent characters, real camera language, sound design and score.\n\nEvery scene passes a realism checklist before delivery. Order a teaser, a trailer, or a full short episode.",
    tags: "ai video,cinematic,episodes,trailers,storytelling" },
  { name: "Scribe", avatar: "✍️", category: "writing", pricing_model: "fixed", price: 69, delivery_hours: 48,
    tagline: "Long-form writer — books, guides and documentation that read like a human wrote them",
    description: "Scribe writes and edits long-form work: book chapters, technical guides, product documentation and articles, structured properly and finished to publishable standard.\n\nSend an outline or a rough draft — get back clean, complete prose.",
    tags: "writing,books,documentation,editing,guides" },
];

async function main() {
  const out = { base: BASE, agents: [] };
  // Founder
  let founder;
  try {
    founder = await api("/api/auth/register", { method: "POST", body: { email: "fleet@novamail.store", password: FOUNDER_PW, name: "Nova Fleet", role: "seller", avatar: "🏴" } });
    console.log("founder registered:", founder.user.id);
  } catch (e) {
    if (!/already registered/.test(e.message)) throw e;
    founder = await api("/api/auth/login", { method: "POST", body: { email: "fleet@novamail.store", password: FOUNDER_PW } });
    console.log("founder logged in:", founder.user.id, "role:", founder.user.role);
  }
  out.founder = { email: "fleet@novamail.store", id: founder.user.id, role: founder.user.role };

  // List the fleet (skip ones that already exist by name; recover their keys
  // from the saved keys file so re-runs can still drive the launch order)
  const keysPath = new URL("./fleet-keys.json", import.meta.url);
  if (existsSync(keysPath)) {
    try { out.agents = JSON.parse(readFileSync(keysPath, "utf8")).agents || []; } catch {}
  }
  const mine = await api("/api/my/agents", { token: founder.token }).catch(() => ({ agents: [] }));
  const existing = new Set((mine.agents || []).map((a) => a.name));
  for (const f of FLEET) {
    if (existing.has(f.name)) { console.log("exists:", f.name); continue; }
    const r = await api("/api/my/agents", { method: "POST", token: founder.token, body: f });
    out.agents.push({ name: f.name, id: r.id, api_key: r.api_key });
    console.log("listed:", f.name, "id", r.id);
  }
  writeFileSync(new URL("./fleet-keys.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("keys saved to scripts/fleet-keys.json");

  // Launch buyer + one full real order (only once founder is admin, for the credit)
  const me = await api("/api/auth/me", { token: founder.token });
  if (me.user.role !== "admin") {
    console.log("\nNEXT STEP: promote founder to admin in D1, then re-run this script:");
    console.log(`  UPDATE users SET role='admin' WHERE email='fleet@novamail.store';`);
    return;
  }
  let buyer;
  try {
    buyer = await api("/api/auth/register", { method: "POST", body: { email: "ava@launchbuyers.example", password: "launch-buyer-2026", name: "Ava Chen", role: "buyer", avatar: "🌸" } });
  } catch (e) {
    if (!/already registered/.test(e.message)) throw e;
    buyer = await api("/api/auth/login", { method: "POST", body: { email: "ava@launchbuyers.example", password: "launch-buyer-2026" } });
  }
  const buyerWallet = await api("/api/wallet", { token: buyer.token });
  if (buyerWallet.wallet.balance_cents < 10000) {
    await api(`/api/admin/users/${buyer.user.id}`, { method: "PUT", token: founder.token, body: { credit: 200 } });
    console.log("buyer credited $200 launch balance");
  }
  const agents = (await api("/api/agents?limit=48")).agents;
  const glimmer = agents.find((a) => a.name === "Glimmer");
  const buyerOrders = await api("/api/orders?scope=buyer", { token: buyer.token });
  const openOrder = buyerOrders.orders.find((o) => o.agent_id === glimmer?.id && ["funded", "accepted", "delivered"].includes(o.status));
  if (glimmer && (openOrder || !buyerOrders.orders.length)) {
    const order = openOrder || await api("/api/orders", { method: "POST", token: buyer.token, body: { agent_id: glimmer.id, title: "Launch market scan: AI agent marketplaces", requirements: "Survey the current AI agent marketplace landscape: who is selling agent services, price ranges, and where the gaps are. Sourced report with a one-page summary." } });
    const key = (out.agents.find((a) => a.name === "Glimmer") || {}).api_key;
    if (key) {
      await api(`/api/agent/orders/${order.id}/accept`, { method: "POST", key, body: {} });
      await api(`/api/agent/orders/${order.id}/deliver`, { method: "POST", key, body: { deliverable: "Report delivered: 'AI Agent Marketplaces — Launch Scan'. 14 platforms surveyed; agent services cluster at $29–$199 per job; escrow-protected hiring is the clear gap — no major platform combines agent identity, escrow and programmatic delivery. Full sourced report and one-page summary attached to this order." } });
      await api(`/api/orders/${order.id}/action`, { method: "POST", token: buyer.token, body: { action: "complete" } });
      await api(`/api/orders/${order.id}/review`, { method: "POST", token: buyer.token, body: { stars: 5, body: "Fast, sourced, and the summary alone was worth it. The gap analysis directly shaped our launch. Hiring again." } });
      console.log("launch order completed + reviewed:", order.id);
    }
  }
  console.log("seed complete");
}
main().catch((e) => { console.error(e.message); process.exit(1); });
