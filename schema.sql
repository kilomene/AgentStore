-- Agent Store schema (D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'buyer',           -- buyer | seller | admin
  avatar TEXT NOT NULL DEFAULT '🤖',
  bio TEXT DEFAULT '',
  suspended INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance_cents INTEGER NOT NULL DEFAULT 0,
  held_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,                            -- deposit | escrow_hold | escrow_release | fee | earning | payout | refund | admin_credit
  amount_cents INTEGER NOT NULL,                 -- signed: + in, - out
  balance_after INTEGER NOT NULL,
  ref TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS categories (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '✨',
  blurb TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL REFERENCES categories(slug),
  avatar TEXT NOT NULL DEFAULT '🤖',
  pricing_model TEXT NOT NULL DEFAULT 'fixed',   -- fixed | hourly | subscription
  price_cents INTEGER NOT NULL DEFAULT 0,
  delivery_hours INTEGER NOT NULL DEFAULT 24,
  tags TEXT NOT NULL DEFAULT '',                 -- comma separated
  status TEXT NOT NULL DEFAULT 'active',         -- active | paused | suspended
  featured INTEGER NOT NULL DEFAULT 0,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  jobs_completed INTEGER NOT NULL DEFAULT 0,
  response_mins INTEGER NOT NULL DEFAULT 60,
  api_key_hash TEXT,
  webhook_url TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_cat ON agents(category, status);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  seller_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  requirements TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'funded',
  -- funded(escrow held) -> accepted -> delivered -> completed | disputed -> refunded/resolved | cancelled
  deliverable TEXT DEFAULT '',
  dispute_reason TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deadline INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_buyer ON orders(buyer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_seller ON orders(seller_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_agent ON orders(agent_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_order ON messages(order_id, created_at);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER UNIQUE NOT NULL REFERENCES orders(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_agent ON reviews(agent_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read, created_at);

CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'crypto',         -- crypto | bank
  destination TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | paid | rejected
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'crypto',         -- crypto | card
  asset TEXT DEFAULT 'USDT',
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | credited | rejected
  tx_ref TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES ('fee_pct', '10');
INSERT OR IGNORE INTO settings (key, value) VALUES ('deposit_addresses', '{"BTC":"bc1qagentstore7xexampleaddress000000000","ETH":"0xAgentStoreExampleAddress00000000000000","USDT":"TAgentStoreExampleAddress00000000000000","USDC":"0xAgentStoreExampleAddress00000000000000"}');

INSERT OR IGNORE INTO categories (slug, name, icon, blurb) VALUES
  ('research', 'Research & Analysis', '🔎', 'Deep research, market scans, fact-finding and reports'),
  ('social', 'Social & Community', '💬', 'DM management, community growth, engagement'),
  ('trading', 'Trading & Finance', '📈', 'Market scouts, signal research, portfolio watch'),
  ('content', 'Content & Video', '🎬', 'Scripts, AI video, thumbnails, copywriting'),
  ('development', 'Development', '🛠️', 'Code, automation, bots, integrations'),
  ('business', 'Business Ops', '💼', 'Lead gen, outreach, data entry, operations'),
  ('writing', 'Writing', '✍️', 'Articles, books, documentation, editing'),
  ('personal', 'Personal Assistant', '🧭', 'Scheduling, travel, inbox, life admin');
