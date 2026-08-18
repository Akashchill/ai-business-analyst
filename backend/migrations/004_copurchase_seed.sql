-- Extra completed orders so "purchased together" has overlapping customers.
-- Idempotent: skip a user+product pair that already exists.

INSERT INTO orders (user_id, product_id, quantity, total, status)
SELECT u.id, p.id, o.quantity, o.total, o.status
FROM (VALUES
  ('jane@example.com', 'Data Connector', 1, 49.00, 'completed'),
  ('akash@example.com', 'Report Builder', 1, 29.00, 'completed'),
  ('bob@example.com', 'Analytics Pro', 1, 99.00, 'completed')
) AS o(email, product_name, quantity, total, status)
JOIN users u ON u.email = o.email
JOIN products p ON p.name = o.product_name
WHERE NOT EXISTS (
  SELECT 1 FROM orders existing
  WHERE existing.user_id = u.id AND existing.product_id = p.id
);
