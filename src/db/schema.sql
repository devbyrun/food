-- Database Schema for Table QR Code Food Ordering System (PostgreSQL)

CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    phone_number VARCHAR(20),
    role VARCHAR(20) NOT NULL DEFAULT 'staff', -- 'admin' (เจ้าของเว็บ), 'manager' (เจ้าของร้าน), 'staff' (พนักงาน)
    avatar_url TEXT DEFAULT '👨‍🍳',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS stores (
    id BIGSERIAL PRIMARY KEY,
    store_code VARCHAR(30) UNIQUE NOT NULL,
    name VARCHAR(150) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    logo_url TEXT,
    banner_url TEXT,
    address TEXT,
    phone_number VARCHAR(20),
    promptpay_number VARCHAR(20),
    promptpay_name VARCHAR(100),
    vat_rate NUMERIC(5,2) DEFAULT 0.00,
    service_charge NUMERIC(5,2) DEFAULT 0.00,
    plan_name VARCHAR(50) DEFAULT 'Professional', -- 'Starter', 'Professional', 'Enterprise'
    subscription_price NUMERIC(10,2) DEFAULT 990.00,
    trial_ends_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days'),
    billing_cycle VARCHAR(20) DEFAULT 'monthly', -- 'monthly', 'yearly'
    telegram_bot_token VARCHAR(150),
    telegram_kitchen_chat_id VARCHAR(100),
    telegram_service_chat_id VARCHAR(100),
    telegram_slip_chat_id VARCHAR(100),
    is_open BOOLEAN DEFAULT TRUE,
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'suspended', 'trial', 'inactive'
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Safe column additions for existing installations
ALTER TABLE stores ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS promptpay_qr_url TEXT;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS plan_name VARCHAR(50) DEFAULT 'Professional';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_price NUMERIC(10,2) DEFAULT 990.00;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (CURRENT_TIMESTAMP + INTERVAL '30 days');
ALTER TABLE stores ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(20) DEFAULT 'monthly';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS telegram_slip_chat_id VARCHAR(100);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS line_user_id VARCHAR(100);

-- LINE Login & User Profile columns
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_user_id VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_display_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_picture_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS line_access_token TEXT;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;


CREATE TABLE IF NOT EXISTS store_users (
    id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL DEFAULT 'staff', -- 'manager', 'staff'
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_id, user_id)
);

CREATE TABLE IF NOT EXISTS table_zones (
    id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    sort_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS restaurant_tables (
    id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    zone_id BIGINT REFERENCES table_zones(id) ON DELETE SET NULL,
    table_number VARCHAR(20) NOT NULL,
    seat_capacity INT DEFAULT 4,
    qr_token VARCHAR(100) UNIQUE NOT NULL,
    status VARCHAR(20) DEFAULT 'available', -- 'available', 'occupied', 'reserved', 'cleaning', 'bill_requested'
    current_order_id BIGINT,
    is_takeaway BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(store_id, table_number)
);

CREATE TABLE IF NOT EXISTS categories (
    id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    icon_url VARCHAR(255),
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS menus (
    id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    price NUMERIC(10,2) NOT NULL,
    special_price NUMERIC(10,2),
    image_url TEXT,
    is_available BOOLEAN DEFAULT TRUE,
    is_recommend BOOLEAN DEFAULT FALSE,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS option_groups (
    id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    is_required BOOLEAN DEFAULT FALSE,
    min_select INT DEFAULT 0,
    max_select INT DEFAULT 1
);

CREATE TABLE IF NOT EXISTS option_items (
    id BIGSERIAL PRIMARY KEY,
    group_id BIGINT NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    extra_price NUMERIC(10,2) DEFAULT 0.00,
    is_available BOOLEAN DEFAULT TRUE,
    sort_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_option_groups (
    menu_id BIGINT NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    group_id BIGINT NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
    PRIMARY KEY(menu_id, group_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    order_number VARCHAR(30) UNIQUE NOT NULL,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    table_id BIGINT NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
    customer_name VARCHAR(100),
    customer_count INT DEFAULT 1,
    status VARCHAR(20) DEFAULT 'active', -- 'active', 'completed', 'cancelled'
    subtotal_amount NUMERIC(10,2) DEFAULT 0.00,
    discount_amount NUMERIC(10,2) DEFAULT 0.00,
    service_amount NUMERIC(10,2) DEFAULT 0.00,
    vat_amount NUMERIC(10,2) DEFAULT 0.00,
    net_amount NUMERIC(10,2) DEFAULT 0.00,
    payment_status VARCHAR(20) DEFAULT 'unpaid', -- 'unpaid', 'paid', 'refunded'
    opened_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    closed_at TIMESTAMPTZ,
    created_by VARCHAR(50) DEFAULT 'customer_qr'
);

CREATE TABLE IF NOT EXISTS order_items (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_id BIGINT REFERENCES menus(id) ON DELETE SET NULL,
    menu_name VARCHAR(150) NOT NULL,
    unit_price NUMERIC(10,2) NOT NULL,
    quantity INT NOT NULL DEFAULT 1,
    options_price NUMERIC(10,2) DEFAULT 0.00,
    total_price NUMERIC(10,2) NOT NULL,
    special_notes VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'cooking', 'ready', 'served', 'cancelled'
    telegram_msg_id VARCHAR(50),
    ordered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS order_item_options (
    id BIGSERIAL PRIMARY KEY,
    order_item_id BIGINT NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    option_name VARCHAR(100) NOT NULL,
    extra_price NUMERIC(10,2) DEFAULT 0.00
);

CREATE TABLE IF NOT EXISTS payments (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    payment_method VARCHAR(30) NOT NULL, -- 'cash', 'promptpay', 'credit_card'
    amount_received NUMERIC(10,2) NOT NULL,
    change_amount NUMERIC(10,2) DEFAULT 0.00,
    slip_image_url VARCHAR(255),
    received_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    paid_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_calls (
    id BIGSERIAL PRIMARY KEY,
    store_id BIGINT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
    table_id BIGINT NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
    call_type VARCHAR(30) DEFAULT 'call_staff', -- 'call_staff', 'check_bill', 'water', 'custom'
    note VARCHAR(255),
    status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'acknowledged', 'done'
    called_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ
);

-- Indexes for lightning fast queries
CREATE INDEX IF NOT EXISTS idx_tables_store_token ON restaurant_tables(store_id, qr_token);
CREATE INDEX IF NOT EXISTS idx_menus_store_category ON menus(store_id, category_id, is_available);
CREATE INDEX IF NOT EXISTS idx_orders_store_status ON orders(store_id, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_order_items_order_status ON order_items(order_id, status);

CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    subtitle VARCHAR(255),
    price_monthly NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    price_yearly NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    features JSONB NOT NULL DEFAULT '[]'::jsonb,
    disabled_features JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_featured BOOLEAN DEFAULT FALSE,
    badge_text VARCHAR(50),
    sort_order INT DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Persistent Cloud Image & Media Storage Table (Neon PostgreSQL)
CREATE TABLE IF NOT EXISTS uploaded_media (
    id BIGSERIAL PRIMARY KEY,
    file_name VARCHAR(255) NOT NULL UNIQUE,
    original_name VARCHAR(255),
    folder VARCHAR(50) DEFAULT 'uploads',
    mime_type VARCHAR(100) NOT NULL DEFAULT 'image/jpeg',
    file_size INT DEFAULT 0,
    data BYTEA NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_uploaded_media_folder ON uploaded_media(folder);
CREATE INDEX IF NOT EXISTS idx_uploaded_media_filename ON uploaded_media(file_name);


