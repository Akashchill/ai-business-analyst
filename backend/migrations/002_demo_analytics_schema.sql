-- ============================================================
-- Demo analytics schema — business tables for SQL agent queries
-- Run after 001_rag_vector_setup.sql (npm run db:migrate)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  role        TEXT DEFAULT 'customer',
  country     TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT,
  price       NUMERIC(10, 2) NOT NULL,
  stock       INTEGER DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  product_id  INTEGER REFERENCES products(id),
  quantity    INTEGER NOT NULL DEFAULT 1,
  total       NUMERIC(10, 2) NOT NULL,
  status      TEXT DEFAULT 'completed',
  ordered_at  TIMESTAMPTZ DEFAULT now()
);

-- Seed only when tables are empty (idempotent)
INSERT INTO users (name, email, role, country)
SELECT * FROM (VALUES
  ('Akash Kumar', 'akash@example.com', 'customer', 'India'),
  ('Jane Smith', 'jane@example.com', 'customer', 'USA'),
  ('Bob Wilson', 'bob@example.com', 'customer', 'UK')
) AS v(name, email, role, country)
WHERE NOT EXISTS (SELECT 1 FROM users LIMIT 1);

INSERT INTO products (name, category, price, stock)
SELECT * FROM (VALUES
  ('Analytics Pro', 'Software', 99.00, 500),
  ('Data Connector', 'Integration', 49.00, 200),
  ('Report Builder', 'Software', 29.00, 350)
) AS v(name, category, price, stock)
WHERE NOT EXISTS (SELECT 1 FROM products LIMIT 1);

INSERT INTO orders (user_id, product_id, quantity, total, status)
SELECT u.id, p.id, o.quantity, o.total, o.status
FROM (VALUES
  (1, 1, 1, 99.00, 'completed'),
  (1, 2, 2, 98.00, 'completed'),
  (2, 1, 1, 99.00, 'completed'),
  (3, 3, 3, 87.00, 'pending')
) AS o(user_idx, product_idx, quantity, total, status)
JOIN users u ON u.id = o.user_idx
JOIN products p ON p.id = o.product_idx
WHERE NOT EXISTS (SELECT 1 FROM orders LIMIT 1);

CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders(user_id);
CREATE INDEX IF NOT EXISTS orders_product_id_idx ON orders(product_id);
CREATE INDEX IF NOT EXISTS orders_ordered_at_idx ON orders(ordered_at);
