-- Sample schema for developing / testing Quarry against dev/test-db.sh.
DROP SCHEMA IF EXISTS shop;
CREATE SCHEMA shop DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
USE shop;

CREATE TABLE customers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  email VARCHAR(190) NOT NULL,
  name VARCHAR(120) NOT NULL,
  country CHAR(2) NULL,
  meta JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customers_email (email)
) COMMENT='People who buy things';

CREATE TABLE products (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  sku VARCHAR(32) NOT NULL,
  title VARCHAR(200) NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_products_sku (sku)
);

CREATE TABLE orders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,
  status ENUM('new','paid','shipped','cancelled') NOT NULL DEFAULT 'new',
  total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  placed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_orders_status (status),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE order_items (
  order_id INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  qty INT NOT NULL DEFAULT 1,
  unit_price DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id)
);

CREATE TABLE audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  happened_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  message VARCHAR(500) NOT NULL,
  payload BLOB NULL,
  PRIMARY KEY (id)
);

CREATE TABLE no_key_table (
  label VARCHAR(50),
  value INT
);

INSERT INTO customers (email, name, country, meta) VALUES
  ('ada@example.com', 'Ada Lovelace', 'GB', '{"vip": true, "tags": ["math", "engines"]}'),
  ('alan@example.com', 'Alan Turing', 'GB', NULL),
  ('grace@example.com', 'Grace Hopper', 'US', '{"vip": false}'),
  ('linus@example.com', 'Linus Torvalds', 'FI', NULL),
  ('margaret@example.com', 'Margaret Hamilton', 'US', '{"note": "line one\\nline two"}');

INSERT INTO products (sku, title, price) VALUES
  ('KB-01', 'Mechanical keyboard', 129.00), ('MS-02', 'Trackball', 59.50), ('MN-27', '27" monitor', 349.99),
  ('CB-10', 'USB-C cable', 9.99), ('DK-05', 'Desk lamp', 42.00);

INSERT INTO orders (customer_id, status, total, note) VALUES
  (1, 'paid', 188.50, NULL), (2, 'new', 349.99, 'Leave at door'), (3, 'shipped', 19.98, NULL), (1, 'cancelled', 42.00, 'Changed mind');

INSERT INTO order_items VALUES (1, 1, 1, 129.00), (1, 2, 1, 59.50), (2, 3, 1, 349.99), (3, 4, 2, 9.99), (4, 5, 1, 42.00);

INSERT INTO audit_log (message, payload) VALUES ('seeded', 0xDEADBEEF), ('binary null', NULL);
INSERT INTO no_key_table VALUES ('a', 1), ('b', 2);

-- 2,000 synthetic rows to exercise the grid and paging
SET SESSION cte_max_recursion_depth = 5000;
INSERT INTO audit_log (message)
WITH RECURSIVE n AS (SELECT 1 AS i UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
SELECT CONCAT('event #', i) FROM n;

CREATE VIEW order_summary AS
  SELECT o.id, c.name AS customer, o.status, o.total, COUNT(i.product_id) AS line_count
    FROM orders o JOIN customers c ON c.id = o.customer_id
    LEFT JOIN order_items i ON i.order_id = o.id
   GROUP BY o.id, c.name, o.status, o.total;

DELIMITER $$
CREATE PROCEDURE orders_for(IN p_customer INT)
BEGIN
  SELECT * FROM orders WHERE customer_id = p_customer;
END$$

CREATE FUNCTION order_count(p_customer INT) RETURNS INT
READS SQL DATA
BEGIN
  RETURN (SELECT COUNT(*) FROM orders WHERE customer_id = p_customer);
END$$

CREATE TRIGGER trg_orders_audit AFTER INSERT ON orders FOR EACH ROW
BEGIN
  INSERT INTO audit_log (message) VALUES (CONCAT('order ', NEW.id, ' placed'));
END$$
DELIMITER ;
