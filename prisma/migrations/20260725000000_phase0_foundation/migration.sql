CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE account_role AS ENUM ('admin');
CREATE TYPE entity_type AS ENUM ('individual');
CREATE TYPE filing_method AS ENUM ('blue', 'white');
CREATE TYPE consumption_tax_status AS ENUM ('exempt', 'taxable', 'invoice_registered');
CREATE TYPE blue_deduction_target AS ENUM ('none', '100k', '550k', '650k');
CREATE TYPE inventory_valuation_method AS ENUM ('specific', 'last_purchase_cost', 'gross_average', 'other');
CREATE TYPE fiscal_year_status AS ENUM ('open', 'closing', 'locked');

CREATE TABLE workspace (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Tokyo',
  base_currency text NOT NULL DEFAULT 'JPY',
  setup_completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT workspace_timezone_check CHECK (timezone = 'Asia/Tokyo'),
  CONSTRAINT workspace_base_currency_check CHECK (base_currency = 'JPY')
);

CREATE TABLE operator (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, display_name)
);
CREATE INDEX operator_workspace_active_idx ON operator(workspace_id, active);

CREATE TABLE user_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  login_name text NOT NULL,
  normalized_name text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role account_role NOT NULL DEFAULT 'admin',
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, normalized_name)
);
CREATE TABLE auth_login_throttle (
  normalized_name text PRIMARY KEY,
  failure_count integer NOT NULL DEFAULT 0,
  window_started_at timestamptz(3) NOT NULL,
  blocked_until timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE reporting_entity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  display_name text NOT NULL,
  entity_type entity_type NOT NULL DEFAULT 'individual',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, display_name)
);
CREATE INDEX reporting_entity_workspace_active_idx ON reporting_entity(workspace_id, active);

CREATE TABLE fiscal_year_profile (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporting_entity_id uuid NOT NULL REFERENCES reporting_entity(id) ON DELETE RESTRICT,
  year smallint NOT NULL,
  filing_method filing_method NOT NULL,
  consumption_tax_status consumption_tax_status NOT NULL,
  blue_deduction_target blue_deduction_target NOT NULL,
  inventory_valuation_method inventory_valuation_method NOT NULL,
  inventory_valuation_method_note text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  status fiscal_year_status NOT NULL DEFAULT 'open',
  locked_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (reporting_entity_id, year),
  CONSTRAINT fiscal_year_dates_check CHECK (start_date <= end_date),
  CONSTRAINT fiscal_year_other_note_check CHECK (inventory_valuation_method <> 'other' OR length(trim(inventory_valuation_method_note)) > 0),
  CONSTRAINT fiscal_year_white_deduction_check CHECK (filing_method <> 'white' OR blue_deduction_target = 'none'),
  CONSTRAINT fiscal_year_lock_check CHECK ((status = 'locked') = (locked_at IS NOT NULL))
);
CREATE INDEX fiscal_year_profile_year_status_idx ON fiscal_year_profile(year, status);

CREATE TABLE business_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  default_operator_id uuid REFERENCES operator(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, code),
  UNIQUE (workspace_id, name),
  CONSTRAINT business_unit_color_check CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);
CREATE INDEX business_unit_workspace_active_idx ON business_unit(workspace_id, active);

CREATE TABLE business_unit_assignment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT,
  fiscal_year_profile_id uuid NOT NULL REFERENCES fiscal_year_profile(id) ON DELETE RESTRICT,
  effective_from date NOT NULL,
  effective_to date NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_unit_id, fiscal_year_profile_id, effective_from),
  CONSTRAINT business_unit_assignment_dates_check CHECK (effective_from <= effective_to),
  CONSTRAINT business_unit_assignment_no_overlap EXCLUDE USING gist (
    business_unit_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);
CREATE INDEX business_unit_assignment_range_idx ON business_unit_assignment(business_unit_id, effective_from, effective_to);

CREATE TABLE auth_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_account_id uuid NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  active_operator_id uuid REFERENCES operator(id) ON DELETE SET NULL,
  active_business_unit_id uuid REFERENCES business_unit(id) ON DELETE SET NULL,
  selected_year smallint,
  expires_at timestamptz(3) NOT NULL,
  absolute_expires_at timestamptz(3) NOT NULL,
  last_seen_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT auth_session_expiry_check CHECK (expires_at <= absolute_expires_at)
);
CREATE INDEX auth_session_account_revoked_idx ON auth_session(user_account_id, revoked_at);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  user_account_id uuid REFERENCES user_account(id) ON DELETE SET NULL,
  operator_id uuid REFERENCES operator(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  before_json jsonb,
  after_json jsonb,
  occurred_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  request_id text
);
CREATE INDEX audit_log_workspace_occurred_idx ON audit_log(workspace_id, occurred_at);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, entity_id);
