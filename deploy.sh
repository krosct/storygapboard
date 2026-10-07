#!/usr/bin/env bash
# StoryGapBoard: the single deploy script. Runs natively (no Docker).
#
#   ./deploy.sh local       build and run on http://localhost:8080 (Ctrl+C stops)
#
# Production deploys run from GitHub Actions (.github/workflows/ci-cd.yml): CI
# builds a release package of the tested commit and sends it, with this script,
# over SSH. On the server nothing has to be prepared by hand:
#   deploy.sh bootstrap PATH SHA PACKAGE SHA256   (CI, script on stdin)
#   deploy.sh release-up STATE SHA                (internal, run from the release)
#   deploy.sh supervise STATE                     (internal, every minute: self-healing)
#   PATH/current/deploy.sh production status|logs|restart|stop   (optional helpers)
#
# On the server it only creates/updates what belongs to this app: the project
# folder (releases/, current, .venv, tools/, data/, .env, storygapboard.caddy),
# its own user service/timer or crontab lines, and - only when the deploy user
# can sudo without a password - one "import" line in the main Caddyfile (backed
# up, validated, rolled back on failure). It never touches other apps.
set -euo pipefail

SERVICE=storygapboard
LOCAL_PORT="${LOCAL_PORT:-8080}"
MIN_PYTHON="3.10"
SERVER_PYTHON="3.12"           # managed by uv on the server, independent of the system
UV_VERSION="0.12.23"
UV_SHA256_x86_64="9167d72b3319674b6303c4cbe071854bba13ebdf3d76b1a7cbdc175471fb66d6"
UV_SHA256_aarch64="6524bd338177ed50d035d39354e12545e993bbeba2ecbddf0480c5b3a81d313f"
# Caddy installed ONLY when the server has none running and ports 80/443 are free.
CADDY_VERSION="2.11.7"
CADDY_SHA512_amd64="a7a433a1b133efc3c8d10eb0b99d52a24b5ef5c322dc77f5282182b1c0402139ab83f3a99f0c52409df77d20123fb0b523edad8a66d8f5e49136197bf61ef0e7"
CADDY_SHA512_arm64="3db36ba90c7a6e8dda40ee3dd71fa08844c76b5fb08f61b31e5e78d2ed38e71c51dc7baed875e50d1ca1279196e84302967237386ae87c91ae9f2aaceada682e"
KEEP_RELEASES=3
HEALTH_TIMEOUT_S=60
CRON_TAG="# storygapboard"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
	if [ -f "$0" ]; then sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; fi
	exit "${1:-0}"
}

trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }

file_hash() {
	if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

sha512() {
	if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1
	else shasum -a 512 "$1" | cut -d' ' -f1; fi
}

port_in_use() { # port [host] (bash only, no Python needed)
	(exec 3<>"/dev/tcp/${2:-127.0.0.1}/$1") 2>/dev/null
}

# --------------------------------------------------------------------------
# .env (parsed, never sourced: it is data, not code). ROOT = folder holding it.
# --------------------------------------------------------------------------

strip_quotes() { local v="$1"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"; printf '%s' "$v"; }

env_value() { # KEY [default]
	local value=""
	if [ -f "$ROOT/.env" ]; then
		value="$(grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2- || true)"
		value="$(strip_quotes "$value")"
	fi
	printf '%s' "${value:-${2:-}}"
}

export_env_file() {
	[ -f "$ROOT/.env" ] || return 0
	local key value
	while IFS='=' read -r key value; do
		[[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
		export "$key=$(strip_quotes "$value")"
	done < "$ROOT/.env"
}

# Replace KEY's line in .env (or append it), keeping every other line as is.
set_env_value() { # key value
	local key="$1" value="$2" line found=0 tmp="$ROOT/.env.tmp"
	while IFS= read -r line || [ -n "$line" ]; do
		if [ "${line%%=*}" = "$key" ] && [ "$found" = 0 ]; then
			printf '%s=%s\n' "$key" "$value"
			found=1
		elif [ "${line%%=*}" != "$key" ]; then
			printf '%s\n' "$line"
		fi
	done < "$ROOT/.env" > "$tmp"
	[ "$found" = 1 ] || printf '%s=%s\n' "$key" "$value" >> "$tmp"
	chmod 600 "$tmp"
	mv "$tmp" "$ROOT/.env"
}

# The same uvicorn command for local and production (only host/port differ).
APP_HOST=127.0.0.1    # where the app listens (the Docker gateway when Caddy runs in a container)
TRUSTED=127.0.0.1     # proxies allowed to set X-Forwarded-For (Caddy)

uvicorn_args() { # host port [trusted proxies]
	printf '%s ' app.main:app --host "$1" --port "$2" --workers 1 \
		--proxy-headers --forwarded-allow-ips "${3:-127.0.0.1}" \
		--no-server-header --no-access-log --timeout-keep-alive 5 --limit-concurrency 200
}

# Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). Only
# requests whose TCP source is in these ranges may set the visitor IP through
# CF-Connecting-IP, so the header cannot be spoofed by anyone else.
CLOUDFLARE_RANGES="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

# This app's Caddy site block (production and, when Caddy is installed, local).
# Behind Cloudflare (cloudflare=1, plain domain) the origin answers both HTTPS
# (Let's Encrypt, falling back to Caddy's internal certificate, for SSL modes
# Full / Full strict) and plain HTTP without a redirect (SSL mode Flexible,
# which would otherwise loop forever).
site_block() { # address upstream_port [upstream_host] [cloudflare 0/1]
	local addr="$1" up="${3:-127.0.0.1}:$2" cf="${4:-0}"
	cat <<EOF
# Generated by deploy.sh for StoryGapBoard. Do not edit: changes are overwritten.
(storygapboard_site) {
	encode zstd gzip
	request_body {
		max_size 28MB
	}
	header {
		-Server
		-Via
		Strict-Transport-Security "max-age=31536000"
	}
	@sgb_assets path /assets/*
	header @sgb_assets Cache-Control "public, max-age=31536000, immutable"
	@sgb_cloudflare remote_ip $CLOUDFLARE_RANGES
	handle @sgb_cloudflare {
		reverse_proxy $up {
			flush_interval -1
			header_up X-Forwarded-For {http.request.header.CF-Connecting-IP}
		}
	}
	handle {
		reverse_proxy $up {
			flush_interval -1
		}
	}
}

$addr {
	import storygapboard_site
EOF
	if [ "$cf" = 1 ] && [[ "$addr" != *://* ]]; then
		printf '\ttls {\n\t\tissuer acme\n\t\tissuer internal\n\t}\n}\n\nhttp://%s {\n\timport storygapboard_site\n}\n' "$addr"
	else
		printf '}\n'
	fi
}

# Healthy = THIS app answers on the port (another app answering 200 does not count).
wait_healthy() { # port
	local waited=0
	until "$ROOT/.venv/bin/python" -c "
import json, urllib.request
base = 'http://$APP_HOST:$1'
assert json.load(urllib.request.urlopen(base + '/api/health', timeout=2)) == {'ok': True}
assert 'layouts' in json.load(urllib.request.urlopen(base + '/api/meta', timeout=2))
" 2>/dev/null; do
		[ "$waited" -ge "$HEALTH_TIMEOUT_S" ] && return 1
		sleep 1
		waited=$((waited + 1))
	done
}

# ==========================================================================
# Local: build and run in the foreground (developer machine)
# ==========================================================================

find_python() {
	local candidate
	for candidate in "${PYTHON:-}" python3.13 python3.12 python3.11 python3.10 python3; do
		[ -n "$candidate" ] || continue
		command -v "$candidate" >/dev/null 2>&1 || continue
		if "$candidate" -c "import sys; sys.exit(sys.version_info < (${MIN_PYTHON/./, }))" 2>/dev/null; then
			PYTHON_BIN="$(command -v "$candidate")"
			return 0
		fi
	done
	return 1
}

node_ok() {
	command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || return 1
	node -e 'const [a,b]=process.versions.node.split(".").map(Number);
		process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)'
}

check_local_dependencies() {
	local missing=()
	find_python || missing+=("Python >= $MIN_PYTHON with venv")
	if [ -n "${PYTHON_BIN:-}" ] && ! "$PYTHON_BIN" -c "import venv, ensurepip" 2>/dev/null; then
		missing+=("Python venv module (python3-venv)")
	fi
	node_ok || missing+=("Node.js 20.19+ or 22.12+ with npm")
	if [ ${#missing[@]} -gt 0 ]; then
		printf '\033[1;31mMissing dependencies\033[0m (install them, then run again):\n' >&2
		printf '  - %s\n' "${missing[@]}" >&2
		exit 1
	fi
	say "Dependencies OK: $("$PYTHON_BIN" --version), Node $(node --version)"
}

setup_local_backend() {
	if [ ! -x "$ROOT/.venv/bin/python" ]; then
		say "Creating the Python virtualenv (.venv)"
		"$PYTHON_BIN" -m venv "$ROOT/.venv"
	fi
	local want have
	want="$(file_hash "$ROOT/backend/requirements.txt")"
	have="$(cat "$ROOT/.venv/.requirements.sha256" 2>/dev/null || true)"
	if [ "$want" != "$have" ]; then
		say "Installing backend dependencies"
		"$ROOT/.venv/bin/python" -m pip install --quiet --upgrade pip
		"$ROOT/.venv/bin/python" -m pip install --quiet -r "$ROOT/backend/requirements.txt"
		printf '%s\n' "$want" > "$ROOT/.venv/.requirements.sha256"
	fi
}

build_frontend() {
	local fe="$ROOT/frontend" want have
	want="$(file_hash "$fe/package-lock.json")"
	have="$(cat "$fe/node_modules/.lock.sha256" 2>/dev/null || true)"
	if [ "$want" != "$have" ]; then
		say "Installing frontend dependencies"
		(cd "$fe" && npm ci --no-audit --no-fund --loglevel=error)
		printf '%s\n' "$want" > "$fe/node_modules/.lock.sha256"
	fi
	say "Building the frontend"
	(cd "$fe" && npm run --silent typecheck && npx vite build --logLevel warn --outDir dist.new --emptyOutDir)
	# Swap in one step so a running app never serves a half-written build.
	rm -rf "$fe/dist.old"
	if [ -d "$fe/dist" ]; then mv "$fe/dist" "$fe/dist.old"; fi
	mv "$fe/dist.new" "$fe/dist"
	rm -rf "$fe/dist.old"
}

run_local() {
	check_local_dependencies
	setup_local_backend
	build_frontend
	mkdir -p "$ROOT/data" && chmod 700 "$ROOT/data"
	export_env_file
	export DATA_DIR="$ROOT/data" FRONTEND_DIST="$ROOT/frontend/dist" PYTHONUNBUFFERED=1
	local app_port="$LOCAL_PORT"
	PIDS=()
	port_in_use "$LOCAL_PORT" && die "Port $LOCAL_PORT is busy. Use another one: LOCAL_PORT=8090 ./deploy.sh local"
	if command -v caddy >/dev/null 2>&1; then
		# Same proxy as production: Caddy on LOCAL_PORT, the app one port above.
		app_port=$((LOCAL_PORT + 1))
		port_in_use "$app_port" && die "Port $app_port is busy. Use another one: LOCAL_PORT=8090 ./deploy.sh local"
		mkdir -p "$ROOT/.run"
		{ printf '{\n\tadmin off\n\tauto_https off\n}\n\n'; site_block "http://localhost:$LOCAL_PORT" "$app_port"; } > "$ROOT/.run/Caddyfile"
	else
		warn "Caddy is not installed: serving the app directly (production runs behind Caddy)."
	fi
	trap 'if [ ${#PIDS[@]} -gt 0 ]; then kill "${PIDS[@]}" 2>/dev/null || true; fi' EXIT
	trap 'exit 130' INT TERM
	# shellcheck disable=SC2046
	(cd "$ROOT/backend" && exec "$ROOT/.venv/bin/uvicorn" $(uvicorn_args 127.0.0.1 "$app_port")) &
	PIDS+=($!)
	if [ "$app_port" != "$LOCAL_PORT" ]; then
		caddy run --adapter caddyfile --config "$ROOT/.run/Caddyfile" >"$ROOT/.run/caddy.log" 2>&1 &
		PIDS+=($!)
	fi
	wait_healthy "$app_port" || die "The app did not become healthy."
	say "Running: http://localhost:$LOCAL_PORT  (Ctrl+C to stop)"
	wait -n "${PIDS[@]}" || true
}

# ==========================================================================
# Server. Layout of the project folder (ROOT, a.k.a. STATE):
#   releases/<sha>/   one folder per deployed commit (code + built frontend)
#   current           symlink to the running release
#   .env  data/  .venv/  tools/ (uv + Python)  .run/ (pids, logs, state)
#   storygapboard.caddy   this app's Caddy site block
# ==========================================================================

can_sudo() { command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; }

systemctl_user() {
	# SSH sessions (e.g. GitHub Actions) may lack the user bus variables.
	export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
	export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
	systemctl --user "$@"
}

download() { # url destination
	if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
	elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys,urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" "$1" "$2"
	else return 1; fi
}

# Only basic tools every Linux server has; everything else the script brings itself.
check_server_basics() {
	local missing=() tool
	for tool in tar gzip mkdir ln mv; do
		command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
	done
	command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || missing+=("sha256sum")
	command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 \
		|| missing+=("curl, wget or python3 (to download the app's own Python)")
	if [ ${#missing[@]} -gt 0 ]; then
		die "This server lacks basic tools: ${missing[*]}"
	fi
}

# --- Python: the app's own interpreter via uv (pinned + checksum verified) ---

ensure_python() {
	local arch expected uv_dir="$ROOT/tools/uv-$UV_VERSION" tmp
	case "$(uname -m)" in
		x86_64|amd64) arch=x86_64; expected="$UV_SHA256_x86_64" ;;
		aarch64|arm64) arch=aarch64; expected="$UV_SHA256_aarch64" ;;
		*) die "Unsupported CPU architecture: $(uname -m)" ;;
	esac
	if [ ! -x "$uv_dir/uv" ]; then
		say "Installing uv $UV_VERSION (the app's own Python manager) into tools/"
		tmp="$(mktemp -d)"
		download "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$arch-unknown-linux-gnu.tar.gz" "$tmp/uv.tgz" \
			|| die "Could not download uv (no internet access from the server?)."
		[ "$(file_hash "$tmp/uv.tgz")" = "$expected" ] || die "uv download failed its checksum; refusing to use it."
		tar -xzf "$tmp/uv.tgz" -C "$tmp"
		mkdir -p "$uv_dir"
		mv "$tmp/uv-$arch-unknown-linux-gnu/uv" "$uv_dir/uv"
		rm -rf "$tmp"
	fi
	UV="$uv_dir/uv"
	export UV_PYTHON_INSTALL_DIR="$ROOT/tools/python" UV_CACHE_DIR="$ROOT/.cache/uv" \
		UV_PYTHON_PREFERENCE=only-managed UV_NO_PROGRESS=1
	if ! "$ROOT/.venv/bin/python" -c "import sys; sys.exit(sys.version_info[:2] != (${SERVER_PYTHON/./, }))" 2>/dev/null; then
		say "Creating the virtualenv with Python $SERVER_PYTHON (downloaded by uv if needed)"
		rm -rf "$ROOT/.venv"
		"$UV" venv --quiet --python "$SERVER_PYTHON" "$ROOT/.venv" || die "Could not create the Python environment."
	fi
	local want have
	want="$(file_hash "$CODE/backend/requirements.txt")"
	have="$(cat "$ROOT/.venv/.requirements.sha256" 2>/dev/null || true)"
	if [ "$want" != "$have" ]; then
		say "Installing backend dependencies"
		"$UV" pip install --quiet --python "$ROOT/.venv/bin/python" -r "$CODE/backend/requirements.txt" \
			|| die "Could not install the backend dependencies."
		printf '%s\n' "$want" > "$ROOT/.venv/.requirements.sha256"
	fi
}

# --- Settings from GitHub (DEPLOY_<KEY> secrets/variables, sent as SGB_ENV) ---

site_url() { # site -> https URL (unless the site already has a scheme)
	if [[ "$1" == *://* ]]; then printf '%s' "$1"; else printf 'https://%s' "$1"; fi
}

# The site address ends up inside the Caddy config: allow address characters
# only (a "{", space or newline could inject Caddy directives).
valid_site() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:/-]*$ ]]; }

# Every .env key CI may set (GitHub secret or variable DEPLOY_<KEY>) and how
# its value is validated. Keep in sync with the deploy job in ci-cd.yml.
ENV_KEYS=(
	SITE_ADDRESS:site PUBLIC_URL:url APP_PORT:port CADDYFILE:path LOG_HASH_SALT:salt
	RATE_API_PER_MINUTE:int RATE_GENERATE_PER_MINUTE:int RATE_GENERATE_PER_DAY:int
	MAX_JOBS_PER_CLIENT:int MAX_CONCURRENT_JOBS:int AUTH_FAILURES_BEFORE_LOCK:int
	AUTH_FAILURE_WINDOW_S:int AUTH_LOCK_S:int JOB_TTL_S:int MAX_STORED_JOBS:int
)

env_key_type() { # key -> type, or fail when the key is not allowed
	local entry
	for entry in "${ENV_KEYS[@]}"; do
		[ "${entry%%:*}" = "$1" ] && { printf '%s' "${entry#*:}"; return 0; }
	done
	return 1
}

valid_value() { # type value
	case "$1" in
		site) valid_site "$2" ;;
		url) [[ "$2" =~ ^https?://[A-Za-z0-9.-]*(:[0-9]{1,5})?(/[A-Za-z0-9._/-]*)?$ ]] ;;
		port) [[ "$2" =~ ^[0-9]{4,5}$ ]] && [ "$2" -ge 1024 ] && [ "$2" -le 65535 ] ;;
		path) [[ "$2" =~ ^/[A-Za-z0-9._/-]+$ ]] ;;
		salt) [[ "$2" =~ ^[A-Za-z0-9_-]{16,256}$ ]] ;;
		int) [[ "$2" =~ ^[0-9]{1,9}$ ]] ;;
		*) return 1 ;;
	esac
}

# CI settings are the source of truth: they create .env on the first deploy and
# overwrite a key whenever its value differs. Keys CI does not send are left as
# they are. Everything is validated before .env is touched; values are never
# printed (some are secret), only the names of the keys that changed.
sync_env_from_ci() {
	local line key value type keys=() values=() i changed=() old_site="" old_url="" new_site="" url_given=0
	while IFS= read -r line || [ -n "$line" ]; do
		line="$(trim "$line")"
		[ -n "$line" ] || continue
		key="${line%%=*}"
		value="$(trim "${line#*=}")"
		[ "$key" = SITE_ADDRESS ] && value="${value%/}"
		type="$(env_key_type "$key")" || die "CI sent an unknown setting: $key"
		valid_value "$type" "$value" || die "DEPLOY_$key has an invalid value (expected: $type); .env was not changed."
		keys+=("$key"); values+=("$value")
		[ "$key" = SITE_ADDRESS ] && new_site="$value"
		[ "$key" = PUBLIC_URL ] && url_given=1
	done <<< "${SGB_ENV:-}"
	if [ ! -f "$ROOT/.env" ]; then
		say "Creating .env from .env.example"
		cp "$CODE/.env.example" "$ROOT/.env"
		chmod 600 "$ROOT/.env"
	else
		old_site="$(env_value SITE_ADDRESS)"
		old_url="$(env_value PUBLIC_URL)"
	fi
	for i in "${!keys[@]}"; do
		if [ "$(env_value "${keys[$i]}")" != "${values[$i]}" ]; then
			set_env_value "${keys[$i]}" "${values[$i]}"
			changed+=("${keys[$i]}")
		fi
	done
	# Without its own setting, PUBLIC_URL follows a changed site unless it was customised by hand.
	if [ -n "$new_site" ] && [ "$url_given" = 0 ] && [ "$old_site" != "$new_site" ]; then
		if [ -z "$old_url" ] || [ -z "$old_site" ] || [ "$old_url" = "$(site_url "$old_site")" ] || [ "$old_url" = "https://example.com" ]; then
			set_env_value PUBLIC_URL "$(site_url "$new_site")"
			changed+=(PUBLIC_URL)
		fi
	fi
	if [ ${#changed[@]} -gt 0 ]; then
		say "Updated .env from the DEPLOY_* settings: ${changed[*]}"
	fi
}

prepare_env() {
	sync_env_from_ci
	local site
	site="$(env_value SITE_ADDRESS)"
	[ -n "$site" ] && [ "$site" != "example.com" ] \
		|| die "No site address: set DEPLOY_SITE_ADDRESS (secret or variable) in the GitHub \"vars\" environment."
	valid_site "$site" || die "SITE_ADDRESS has invalid characters; use just the domain, e.g. app.example.com"
	if [ -z "$(env_value LOG_HASH_SALT)" ]; then
		say "Generating LOG_HASH_SALT in .env"
		set_env_value LOG_HASH_SALT "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
	fi
	chmod 600 "$ROOT/.env"
	mkdir -p "$ROOT/data" && chmod 700 "$ROOT/data"
}

# --- Keeping the app running: systemd user service (needs linger) or cron ---

linger_on() { [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" = yes ]; }

choose_supervisor() {
	if command -v systemctl >/dev/null 2>&1 && command -v loginctl >/dev/null 2>&1; then
		if ! linger_on; then
			# Lets the user's services run without an open session. Allowed for
			# oneself on most systems; otherwise via passwordless sudo.
			loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
			linger_on || { can_sudo && sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1; } || true
			linger_on && say "Enabled linger for $(id -un) (the app keeps running after logout)"
		fi
		if linger_on && systemctl_user show-environment >/dev/null 2>&1; then
			SUPERVISOR=systemd
			return 0
		fi
	fi
	if command -v crontab >/dev/null 2>&1; then
		warn "systemd user services are not available for $(id -un); using a cron watchdog instead."
		SUPERVISOR=cron
		return 0
	fi
	die "Cannot keep the app running: neither systemd user services (linger) nor cron are available to $(id -un)."
}

unit_dir() { printf '%s' "$HOME/.config/systemd/user"; }

write_if_changed() { # file content -> 0 if written
	if [ "$(cat "$1" 2>/dev/null || true)" != "$2" ]; then
		printf '%s\n' "$2" > "$1"
		return 0
	fi
	return 1
}

install_systemd_service() { # port
	local dir changed=0
	dir="$(unit_dir)"
	mkdir -p "$dir"
	write_if_changed "$dir/$SERVICE.service" "$(cat <<EOF
# Generated by deploy.sh for StoryGapBoard. Do not edit: changes are overwritten.
[Unit]
Description=StoryGapBoard web app
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/current/backend
EnvironmentFile=-$ROOT/.env
Environment=DATA_DIR=$ROOT/data
Environment=FRONTEND_DIST=$ROOT/current/frontend/dist
Environment=PYTHONUNBUFFERED=1
ExecStart=$ROOT/.venv/bin/uvicorn $(uvicorn_args "$APP_HOST" "$1" "$TRUSTED")
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
UMask=0077
MemoryMax=1G
TasksMax=256

[Install]
WantedBy=default.target
EOF
)" && changed=1
	# Watchdog: re-applies the Caddy route when Caddy dropped it (API mode).
	write_if_changed "$dir/$SERVICE-watchdog.service" "$(cat <<EOF
# Generated by deploy.sh for StoryGapBoard.
[Unit]
Description=StoryGapBoard self-healing watchdog

[Service]
Type=oneshot
ExecStart=$ROOT/current/deploy.sh supervise $ROOT
EOF
)" && changed=1
	write_if_changed "$dir/$SERVICE-watchdog.timer" "$(cat <<EOF
# Generated by deploy.sh for StoryGapBoard.
[Unit]
Description=StoryGapBoard self-healing watchdog (every minute)

[Timer]
OnBootSec=30
OnUnitActiveSec=60

[Install]
WantedBy=timers.target
EOF
)" && changed=1
	if [ "$changed" = 1 ]; then systemctl_user daemon-reload; fi
	systemctl_user enable --quiet "$SERVICE" "$SERVICE-watchdog.timer"
	systemctl_user start --quiet "$SERVICE-watchdog.timer"
}

remove_systemd_service() {
	command -v systemctl >/dev/null 2>&1 || return 0
	[ -f "$(unit_dir)/$SERVICE.service" ] || return 0
	systemctl_user disable --now --quiet "$SERVICE" "$SERVICE-watchdog.timer" 2>/dev/null || true
	rm -f "$(unit_dir)/$SERVICE.service" "$(unit_dir)/$SERVICE-watchdog.service" "$(unit_dir)/$SERVICE-watchdog.timer"
	systemctl_user daemon-reload 2>/dev/null || true
}

install_cron() {
	local lines
	lines="@reboot $ROOT/current/deploy.sh supervise $ROOT >/dev/null 2>&1 $CRON_TAG
* * * * * $ROOT/current/deploy.sh supervise $ROOT >/dev/null 2>&1 $CRON_TAG"
	# Only this app's lines (tagged) are replaced; the rest of the crontab is kept.
	{ crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; printf '%s\n' "$lines"; } | crontab -
}

remove_cron() {
	command -v crontab >/dev/null 2>&1 || return 0
	crontab -l 2>/dev/null | grep -qF "$CRON_TAG" || return 0
	{ crontab -l 2>/dev/null | grep -vF "$CRON_TAG" || true; } | crontab -
}

cron_app_pid() {
	local pid
	pid="$(cat "$ROOT/.run/app.pid" 2>/dev/null || true)"
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q uvicorn "/proc/$pid/cmdline" 2>/dev/null && printf '%s' "$pid"
}

cron_start_app() {
	local port host trusted
	port="$(env_value APP_PORT 8787)"
	read -r host trusted < "$ROOT/.run/net" 2>/dev/null || { host=127.0.0.1; trusted=127.0.0.1; }
	mkdir -p "$ROOT/.run"
	(
		export_env_file
		export DATA_DIR="$ROOT/data" FRONTEND_DIST="$ROOT/current/frontend/dist" PYTHONUNBUFFERED=1
		cd "$ROOT/current/backend"
		umask 077
		local detach=()
		command -v setsid >/dev/null 2>&1 && detach=(setsid)
		# 9>&- : the app must not inherit the deploy lock.
		# shellcheck disable=SC2046
		nohup "${detach[@]}" "$ROOT/.venv/bin/uvicorn" $(uvicorn_args "$host" "$port" "$trusted") \
			>> "$ROOT/.run/app.log" 2>&1 < /dev/null 9>&- &
		printf '%s\n' "$!" > "$ROOT/.run/app.pid"
	)
}

cron_stop_app() {
	local pid i
	pid="$(cron_app_pid || true)"
	[ -n "$pid" ] || return 0
	kill "$pid" 2>/dev/null || true
	for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.5; done
	kill -9 "$pid" 2>/dev/null || true
}

app_running() {
	case "$(cat "$ROOT/.run/supervisor" 2>/dev/null || true)" in
		systemd) systemctl_user is-active --quiet "$SERVICE" 2>/dev/null ;;
		cron) [ -n "$(cron_app_pid || true)" ] ;;
		*) return 1 ;;
	esac
}

app_port_running() { cat "$ROOT/.run/port" 2>/dev/null || true; }

restart_app() { # port
	if [ "$SUPERVISOR" = systemd ]; then
		remove_cron
		cron_stop_app
		install_systemd_service "$1"
		systemctl_user restart "$SERVICE"
	else
		remove_systemd_service
		cron_stop_app
		cron_start_app
		install_cron
	fi
	printf '%s\n' "$SUPERVISOR" > "$ROOT/.run/supervisor"
	printf '%s\n' "$1" > "$ROOT/.run/port"
}

show_app_log() {
	if [ "$(cat "$ROOT/.run/supervisor" 2>/dev/null)" = systemd ]; then
		journalctl --user -u "$SERVICE" -n 40 --no-pager >&2 || true
	else
		tail -n 40 "$ROOT/.run/app.log" >&2 2>/dev/null || true
	fi
}

# --- Caddy ------------------------------------------------------------------
# First find the RUNNING Caddy (its process tells which config it uses and
# whether it lives in a container), then pick the best mode:
#   import       host Caddy already imports storygapboard.caddy
#   sudo-import  host Caddy + passwordless sudo: add that one import line
#                (backup, validation, automatic restore)
#   api          host Caddy, no sudo: register the site through the admin API,
#                re-applied every minute if a Caddy reload dropped it
#   docker       Caddy in a container + docker access: managed block in the
#                Caddyfile it mounts; app reachable on the Docker network only
#   manual       nothing possible: the final report explains why

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; elif can_sudo; then sudo -n "$@"; else return 1; fi; }

site_host() { # SITE_ADDRESS without scheme, path or port
	local h
	h="$(env_value SITE_ADDRESS)"; h="${h#*://}"; h="${h%%/*}"; h="${h%%:*}"
	printf '%s' "$h"
}

# 0 when every address of the site's domain belongs to Cloudflare (proxied).
site_on_cloudflare() {
	local host
	host="$(site_host)"
	[ -n "$host" ] && [ "$host" != "${host#*[a-zA-Z]}" ] || return 1
	"$ROOT/.venv/bin/python" - "$host" "$CLOUDFLARE_RANGES" <<'EOF' 2>/dev/null
import ipaddress, socket, sys
nets = [ipaddress.ip_network(r) for r in sys.argv[2].split()]
addrs = {a[4][0] for a in socket.getaddrinfo(sys.argv[1], None)}
ok = addrs and all(any(ipaddress.ip_address(a) in n for n in nets) for a in addrs)
sys.exit(0 if ok else 1)
EOF
}
PY() { "$ROOT/.venv/bin/python" "$@"; }

docker_access() {
	command -v docker >/dev/null 2>&1 || return 1
	if docker info >/dev/null 2>&1; then DOCKER=(docker); return 0; fi
	if can_sudo && sudo -n docker info >/dev/null 2>&1; then DOCKER=(sudo -n docker); return 0; fi
	return 1
}

caddy_discover() {
	CADDY_KIND=none CADDY_PID="" CADDY_CTR="" CADDY_CTR_NAME="" CADDY_CONF="" CADDY_BIN="" CADDY_HOSTFILE="" CADDY_PROBLEM=""
	local d pid args c
	for d in /proc/[0-9]*; do
		[ "$(cat "$d/comm" 2>/dev/null)" = caddy ] || continue
		pid="${d#/proc/}"
		args="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null || true)"
		[ -n "$CADDY_PID" ] || CADDY_PID="$pid"
		case "$args" in *" run"*|*" start"*|*--config*) CADDY_PID="$pid"; break ;; esac
	done
	if [ -n "$CADDY_PID" ]; then
		CADDY_CONF="$(tr '\0' '\n' < "/proc/$CADDY_PID/cmdline" 2>/dev/null | awk 'f{print;exit} $0=="--config"{f=1} /^--config=/{sub(/^--config=/,"");print;exit}' || true)"
		CADDY_CTR="$(grep -oE '[0-9a-f]{64}' "/proc/$CADDY_PID/cgroup" 2>/dev/null | head -n1 || true)"
		if [ -n "$CADDY_CTR" ]; then CADDY_KIND=docker; else CADDY_KIND=host; fi
	fi
	if [ "$CADDY_KIND" = docker ]; then
		[ -n "$CADDY_CONF" ] || CADDY_CONF=/etc/caddy/Caddyfile
		return 0
	fi
	CADDY_BIN="$(command -v caddy 2>/dev/null || true)"
	for c in /usr/bin/caddy /usr/local/bin/caddy /snap/bin/caddy /opt/caddy/caddy /usr/sbin/caddy; do
		[ -z "$CADDY_BIN" ] && [ -x "$c" ] && CADDY_BIN="$c"
	done
	if [ -z "$CADDY_BIN" ] && [ -n "$CADDY_PID" ]; then
		c="$(readlink -f "/proc/$CADDY_PID/exe" 2>/dev/null || as_root readlink -f "/proc/$CADDY_PID/exe" 2>/dev/null || true)"
		[ -n "$c" ] && [ -x "$c" ] && CADDY_BIN="$c"
	fi
	if [ "$CADDY_KIND" = none ] && [ -n "$CADDY_BIN" ]; then CADDY_KIND=host; fi
	return 0
}

caddy_file() {
	if [ "$CADDY_KIND" = host ] && [ -n "$CADDY_CONF" ] && [ "${CADDY_CONF#/}" != "$CADDY_CONF" ] && [ -f "$CADDY_CONF" ]; then
		printf '%s' "$CADDY_CONF"
	else
		env_value CADDYFILE /etc/caddy/Caddyfile
	fi
}

caddy_admin() { # host:port of the host Caddy's admin API ("" when off/unix socket)
	local listen
	listen="$(grep -E '^[[:space:]]*admin[[:space:]]+' "$(caddy_file)" 2>/dev/null | awk '{print $2}' | head -n1 || true)"
	case "$listen" in off|unix/*) return 0 ;; "") listen=localhost:2019 ;; esac
	printf '%s' "${listen#tcp/}"
}

caddy_admin_ok() { local a; a="$(caddy_admin)"; [ -n "$a" ] && PY -c "import urllib.request; urllib.request.urlopen('http://$a/config/', timeout=5)" 2>/dev/null; }

# Adapt a Caddyfile to JSON: with the CLI if there is one, else through the admin API.
caddy_adapt() { # file
	if [ -n "$CADDY_BIN" ]; then
		"$CADDY_BIN" adapt --config "$1" --adapter caddyfile 2>/dev/null
	else
		PY - "$(caddy_admin)" "$1" <<'EOF'
import json, sys, urllib.request
req = urllib.request.Request("http://%s/adapt" % sys.argv[1], data=open(sys.argv[2], "rb").read(),
                             method="POST", headers={"Content-Type": "text/caddyfile"})
print(json.dumps(json.load(urllib.request.urlopen(req, timeout=15)).get("result") or {}))
EOF
	fi
}

caddy_reload() { # reload the host Caddy from its Caddyfile (graceful; keeps the old config on failure)
	local cf
	cf="$(caddy_file)"
	if [ -n "$CADDY_BIN" ] && "$CADDY_BIN" reload --config "$cf" --adapter caddyfile >/dev/null 2>&1; then return 0; fi
	if can_sudo && sudo -n systemctl reload caddy >/dev/null 2>&1; then return 0; fi
	PY - "$(caddy_admin)" "$cf" <<'EOF' 2>/dev/null
import sys, urllib.request
req = urllib.request.Request("http://%s/load" % sys.argv[1], data=open(sys.argv[2], "rb").read(),
                             method="POST", headers={"Content-Type": "text/caddyfile"})
urllib.request.urlopen(req, timeout=30)
EOF
}

caddy_imports_us() { # port
	grep -qF "$ROOT/$SERVICE.caddy" "$(caddy_file)" 2>/dev/null || \
		caddy_adapt "$(caddy_file)" 2>/dev/null | grep -q "$APP_HOST:$1"
}

# Caddy reads the snippet as its own user: every parent folder must be
# traversable by others. Folders owned by the deploy user are fixed (o+x only:
# traversal, no listing); others need sudo, else it is reported.
make_snippet_readable() {
	local file="$ROOT/$SERVICE.caddy" d
	chmod 644 "$file"
	d="$(dirname "$file")"
	while :; do
		if [ -n "$(find "$d" -maxdepth 0 ! -perm -o+x 2>/dev/null)" ]; then
			if [ -O "$d" ]; then chmod o+x "$d"
			elif can_sudo; then sudo -n chmod o+x "$d"
			else return 1; fi
		fi
		[ "$d" = / ] && break
		d="$(dirname "$d")"
	done
}

# Docker: where the container's Caddyfile lives on the host, and how the
# container reaches the app (host network, or the Docker network gateway).
docker_discover() {
	CADDY_HOSTFILE="" DOCKER_PROBLEM=""
	docker_access || { DOCKER_PROBLEM="the deploy user cannot use Docker (not in the docker group, no passwordless sudo)"; return 1; }
	local info
	info="$("${DOCKER[@]}" inspect "$CADDY_CTR" 2>/dev/null)" || return 1
	CADDY_CTR_NAME="$(printf '%s' "$info" | PY -c "import json,sys; print(json.load(sys.stdin)[0]['Name'].lstrip('/'))")"
	CADDY_HOSTFILE="$(printf '%s' "$info" | PY -c "
import json, os, sys
c = json.load(sys.stdin)[0]; conf = sys.argv[1]
for m in c.get('Mounts') or []:
    dst, src = m.get('Destination', ''), m.get('Source', '')
    if dst == conf:
        print(src); break
    if conf.startswith(dst.rstrip('/') + '/'):
        print(os.path.join(src, os.path.relpath(conf, dst))); break
" "$CADDY_CONF")"
	local mode net
	mode="$(printf '%s' "$info" | PY -c "import json,sys; print(json.load(sys.stdin)[0]['HostConfig'].get('NetworkMode',''))")"
	if [ "$mode" = host ]; then
		APP_HOST=127.0.0.1; TRUSTED=127.0.0.1
		return 0
	fi
	# The container's own view of its network is always complete (the network's
	# IPAM config may omit the gateway).
	read -r APP_HOST TRUSTED < <(printf '%s' "$info" | PY -c "
import ipaddress, json, sys
for net in (json.load(sys.stdin)[0]['NetworkSettings'].get('Networks') or {}).values():
    gw, ip, plen = net.get('Gateway'), net.get('IPAddress'), net.get('IPPrefixLen')
    if gw and ip and plen:
        print(gw, ipaddress.ip_network(f'{ip}/{plen}', strict=False))
        break") || true
	if [ -z "$APP_HOST" ] || [ -z "$TRUSTED" ]; then
		APP_HOST=127.0.0.1; TRUSTED=127.0.0.1; DOCKER_PROBLEM="could not find the Docker network of container $CADDY_CTR_NAME"
		return 1
	fi
}

caddy_preflight() { # port
	caddy_discover
	APP_HOST=127.0.0.1 TRUSTED=127.0.0.1
	SITE_CF=0
	if site_on_cloudflare; then SITE_CF=1; fi
	case "$CADDY_KIND" in
		docker)
			if docker_discover; then
				if [ -z "$CADDY_HOSTFILE" ] || ! as_root test -f "$CADDY_HOSTFILE"; then
					DOCKER_PROBLEM="its Caddyfile ($CADDY_CONF) is not mounted from the host"
				elif ! as_root test -w "$CADDY_HOSTFILE"; then
					DOCKER_PROBLEM="its Caddyfile on the host ($CADDY_HOSTFILE) is not writable (no passwordless sudo)"
				fi
			fi
			if [ -z "${DOCKER_PROBLEM:-}" ]; then CADDY_MODE=docker; else CADDY_MODE=manual; fi
			;;
		host)
			write_if_changed "$ROOT/$SERVICE.caddy" "$(site_block "$(env_value SITE_ADDRESS)" "$1" 127.0.0.1 "$SITE_CF")" || true
			chmod 644 "$ROOT/$SERVICE.caddy"
			if [ -n "$CADDY_PID" ] && [ "$CADDY_CONF" = "$(own_caddyfile)" ]; then
				CADDY_MODE=own      # the Caddy this script installed earlier
			elif [ -z "$CADDY_PID" ]; then
				own_caddy_preflight  # none running (one installed but stopped is left untouched)
			elif [ -z "$CADDY_BIN" ] && ! caddy_admin_ok; then
				CADDY_MODE=manual
			elif caddy_imports_us "$1"; then
				make_snippet_readable || die "Caddy imports $ROOT/$SERVICE.caddy but cannot read it (a parent folder is not traversable). Nothing was changed."
				CADDY_MODE=import
			elif can_sudo && [ -f "$(caddy_file)" ]; then
				CADDY_MODE=sudo-import
			else
				CADDY_MODE=api
			fi
			;;
		*)
			write_if_changed "$ROOT/$SERVICE.caddy" "$(site_block "$(env_value SITE_ADDRESS)" "$1" 127.0.0.1 "$SITE_CF")" || true
			chmod 644 "$ROOT/$SERVICE.caddy"
			own_caddy_preflight ;;
	esac
	printf '%s %s\n' "$APP_HOST" "$TRUSTED" > "$ROOT/.run/net"
}

# --- Own Caddy: only when the server has no running Caddy -------------------
# Checked first, never forced: if ports 80/443 already belong to another
# program (nginx, Apache, ...), nothing is installed. Otherwise a dedicated
# Caddy (official, pinned, checksum-verified) lives in tools/, runs as this
# app's own service with its config/certificates under caddy/, and only its
# binary gets the capability to use ports 80/443 (needs sudo once). A Caddy
# that is installed on the system but stopped is left untouched.

own_caddy_bin() { printf '%s' "$ROOT/tools/caddy-$CADDY_VERSION/caddy"; }
own_caddyfile() { printf '%s' "$ROOT/caddy/Caddyfile"; }

port_listener() { # port -> who listens on it ("" when free)
	local out=""
	if command -v ss >/dev/null 2>&1; then
		out="$( { as_root ss -ltnpH "( sport = :$1 )" 2>/dev/null || ss -ltnH "( sport = :$1 )" 2>/dev/null; } \
			| awk '{print $4, $6}' | sed 's/users:((//; s/,pid=.*//' | head -n1 || true)"
	elif port_in_use "$1"; then
		out="127.0.0.1:$1"
	fi
	printf '%s' "$out"
}

find_tool() { # name -> path (also /sbin and /usr/sbin, often outside a user's PATH)
	local p c
	p="$(command -v "$1" 2>/dev/null || true)"
	for c in "/usr/sbin/$1" "/sbin/$1" "/usr/bin/$1"; do
		[ -z "$p" ] && [ -x "$c" ] && p="$c"
	done
	printf '%s' "$p"
}

own_caddy_preflight() {
	local busy80 busy443
	busy80="$(port_listener 80)"; busy443="$(port_listener 443)"
	if [ -n "$busy80$busy443" ]; then
		CADDY_MODE=manual
		CADDY_PROBLEM="no Caddy is running and ports 80/443 already belong to another program (${busy80:+80: $busy80}${busy80:+${busy443:+; }}${busy443:+443: $busy443}); not installing Caddy to avoid breaking it"
	elif [ "$(id -u)" = 0 ] || can_sudo; then
		CADDY_MODE=own
	else
		CADDY_MODE=manual
		CADDY_PROBLEM="no Caddy is running; installing one needs passwordless sudo once (to let it use ports 80/443)"
	fi
}

ensure_own_caddy() {
	local arch expected bin tmp setcap getcap
	case "$(uname -m)" in
		x86_64|amd64) arch=amd64; expected="$CADDY_SHA512_amd64" ;;
		aarch64|arm64) arch=arm64; expected="$CADDY_SHA512_arm64" ;;
		*) CADDY_PROBLEM="unsupported CPU for the Caddy download: $(uname -m)"; return 1 ;;
	esac
	bin="$(own_caddy_bin)"
	if [ ! -x "$bin" ]; then
		say "Installing Caddy $CADDY_VERSION for this app into tools/ (the server has none running)"
		tmp="$(mktemp -d)"
		if ! download "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/caddy_${CADDY_VERSION}_linux_$arch.tar.gz" "$tmp/caddy.tgz"; then
			rm -rf "$tmp"; CADDY_PROBLEM="could not download Caddy"; return 1
		fi
		if [ "$(sha512 "$tmp/caddy.tgz")" != "$expected" ]; then
			rm -rf "$tmp"; CADDY_PROBLEM="the Caddy download failed its checksum"; return 1
		fi
		tar -xzf "$tmp/caddy.tgz" -C "$tmp" caddy
		mkdir -p "$(dirname "$bin")"
		mv "$tmp/caddy" "$bin"
		chmod 750 "$bin"
		rm -rf "$tmp"
	fi
	[ "$(id -u)" = 0 ] && return 0
	# Ports below 1024: grant the capability to THIS binary only (checked first).
	getcap="$(find_tool getcap)"
	if [ -n "$getcap" ] && "$getcap" "$bin" 2>/dev/null | grep -q cap_net_bind_service; then
		return 0
	fi
	setcap="$(find_tool setcap)"
	if [ -z "$setcap" ] && command -v apt-get >/dev/null 2>&1; then
		say "Installing setcap (libcap2-bin) with sudo"
		as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libcap2-bin >/dev/null 2>&1 \
			|| { as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 \
				&& as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libcap2-bin >/dev/null 2>&1; } || true
		setcap="$(find_tool setcap)"
	fi
	if [ -z "$setcap" ] || ! as_root "$setcap" cap_net_bind_service=+ep "$bin"; then
		CADDY_PROBLEM="could not allow Caddy to use ports 80/443 (setcap)"; return 1
	fi
	say "Allowed this app's Caddy to use ports 80/443"
}

own_caddy_pid() {
	local pid
	pid="$(cat "$ROOT/.run/caddy.pid" 2>/dev/null || true)"
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && grep -q caddy "/proc/$pid/cmdline" 2>/dev/null && printf '%s' "$pid"
}

own_caddy_running() {
	if [ "$(cat "$ROOT/.run/supervisor" 2>/dev/null || echo "${SUPERVISOR:-}")" = systemd ]; then
		systemctl_user is-active --quiet "$SERVICE-caddy" 2>/dev/null
	else
		[ -n "$(own_caddy_pid || true)" ]
	fi
}

own_caddy_start_cron() {
	(
		export XDG_DATA_HOME="$ROOT/caddy/data" XDG_CONFIG_HOME="$ROOT/caddy/config"
		local detach=()
		command -v setsid >/dev/null 2>&1 && detach=(setsid)
		nohup "${detach[@]}" "$(own_caddy_bin)" run --config "$(own_caddyfile)" --adapter caddyfile \
			>> "$ROOT/.run/caddy.log" 2>&1 < /dev/null 9>&- &
		printf '%s\n' "$!" > "$ROOT/.run/caddy.pid"
	)
}

install_own_caddy_unit() {
	local dir bin unit
	dir="$(unit_dir)"; bin="$(own_caddy_bin)"
	mkdir -p "$dir"
	# No NoNewPrivileges here: it would block the port capability of the binary.
	unit="# Generated by deploy.sh for StoryGapBoard: Caddy dedicated to this app.
[Unit]
Description=Caddy for StoryGapBoard
After=network-online.target

[Service]
Type=simple
Environment=XDG_DATA_HOME=$ROOT/caddy/data
Environment=XDG_CONFIG_HOME=$ROOT/caddy/config
ExecStart=$bin run --config $(own_caddyfile) --adapter caddyfile
ExecReload=$bin reload --config $(own_caddyfile) --adapter caddyfile --force
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target"
	if write_if_changed "$dir/$SERVICE-caddy.service" "$unit"; then systemctl_user daemon-reload; fi
	systemctl_user enable --quiet "$SERVICE-caddy"
}

# Inbound 80/443 must be open for the site and its certificate. Only touched
# when a firewall on THIS server blocks them: ufw rules, or tagged iptables /
# ip6tables rules when INPUT drops by default or ends with a catch-all
# REJECT/DROP (as in Oracle Cloud's Ubuntu images). Plain iptables rules do not
# survive a reboot, so the watchdog re-checks them every minute.
input_blocks_by_default() { # iptables|ip6tables
	local rules
	rules="$(as_root "$1" -S INPUT 2>/dev/null)" || return 1
	printf '%s\n' "$rules" | grep -qE '^-P INPUT (DROP|REJECT)' && return 0
	printf '%s\n' "$rules" | grep -qE '^-A INPUT -j (REJECT|DROP)( --reject-with [a-z0-9-]+)?$'
}

open_web_ports() { # [quiet]
	local p tool bin
	if command -v ufw >/dev/null 2>&1 && as_root ufw status 2>/dev/null | grep -q "Status: active"; then
		for p in 80 443; do
			as_root ufw status 2>/dev/null | grep -qE "^$p(/tcp)?[[:space:]]+ALLOW" && continue
			[ -n "${1:-}" ] || say "Allowing inbound port $p in ufw"
			as_root ufw allow "$p/tcp" comment storygapboard >/dev/null 2>&1 || true
		done
		return 0
	fi
	for tool in iptables ip6tables; do
		bin="$(find_tool "$tool")"
		[ -n "$bin" ] && input_blocks_by_default "$bin" || continue
		for p in 80 443; do
			as_root "$bin" -C INPUT -p tcp --dport "$p" -m comment --comment storygapboard -j ACCEPT 2>/dev/null && continue
			[ -n "${1:-}" ] || say "Allowing inbound port $p in $tool (it rejected everything but SSH)"
			as_root "$bin" -I INPUT -p tcp --dport "$p" -m comment --comment storygapboard -j ACCEPT 2>/dev/null || true
		done
	done
}

own_caddy_apply() {
	local cf state want i
	ensure_own_caddy || return 1
	mkdir -p "$ROOT/caddy/data" "$ROOT/caddy/config"
	chmod 700 "$ROOT/caddy"
	write_if_changed "$(own_caddyfile)" "$(printf '# Generated by deploy.sh for StoryGapBoard: Caddy dedicated to this app.\n{\n\tadmin unix/%s\n}\n\nimport %s\n' "$ROOT/.run/caddy-admin.sock" "$ROOT/$SERVICE.caddy")" || true
	cf="$(own_caddyfile)"
	"$(own_caddy_bin)" adapt --config "$cf" --adapter caddyfile >/dev/null 2>&1 || { CADDY_PROBLEM="the generated Caddy config is invalid"; return 1; }
	state="$ROOT/.run/caddy.sha256"
	want="$(cat "$cf" "$ROOT/$SERVICE.caddy" | sha256sum | cut -d' ' -f1)"
	if [ "$SUPERVISOR" = systemd ]; then
		install_own_caddy_unit
		if ! own_caddy_running; then systemctl_user restart "$SERVICE-caddy"
		elif [ "$(cat "$state" 2>/dev/null || true)" != "$want" ]; then systemctl_user reload "$SERVICE-caddy"; fi
	else
		if ! own_caddy_running; then own_caddy_start_cron
		elif [ "$(cat "$state" 2>/dev/null || true)" != "$want" ]; then
			"$(own_caddy_bin)" reload --config "$cf" --adapter caddyfile >/dev/null 2>&1 \
				|| { kill "$(own_caddy_pid)" 2>/dev/null; sleep 1; own_caddy_start_cron; }
		fi
	fi
	for i in $(seq 1 20); do own_caddy_running && break; sleep 0.5; done
	if ! own_caddy_running; then
		if [ "$SUPERVISOR" = systemd ]; then journalctl --user -u "$SERVICE-caddy" -n 20 --no-pager >&2 || true
		else tail -n 20 "$ROOT/.run/caddy.log" >&2 2>/dev/null || true; fi
		CADDY_PROBLEM="this app's Caddy did not start (see its log above)"; return 1
	fi
	printf '%s\n' "$want" > "$state"
	open_web_ports
	printf 'own\n' > "$ROOT/.run/caddy-mode"
}

# Adds/replaces this app's routes in the running host Caddy (tagged with @id,
# so nothing else is touched). Returns 0 on success.
caddy_api_apply() {
	local admin tmp
	admin="$(caddy_admin)"
	[ -n "$admin" ] || return 1
	tmp="$(mktemp -d)"
	cp "$ROOT/$SERVICE.caddy" "$tmp/Caddyfile"
	caddy_adapt "$tmp/Caddyfile" > "$ROOT/.run/caddy-site.json" 2>/dev/null || { rm -rf "$tmp"; return 1; }
	rm -rf "$tmp"
	printf '%s\n' "$admin" > "$ROOT/.run/caddy-admin"
	PY - "$admin" "$ROOT/.run/caddy-site.json" 2>/dev/null <<'EOF'
import json, sys, urllib.error, urllib.request
admin, site_file = sys.argv[1], sys.argv[2]
base = "http://" + admin

def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as exc:
        return exc.code, None

ours = json.load(open(site_file))
our_servers = ((ours.get("apps") or {}).get("http") or {}).get("servers") or {}
if not our_servers:
    sys.exit(1)
for prefix in ("storygapboard_route_", "storygapboard_server_"):
    for i in range(100):
        if call("DELETE", f"/id/{prefix}{i}")[0] == 404:
            break
status, current = call("GET", "/config/apps/http/servers")
current = current if status == 200 and current else {}
route_n = server_n = 0
for srv in our_servers.values():
    listen = sorted(srv.get("listen") or [])
    target = next((name for name, s in current.items() if sorted(s.get("listen") or []) == listen), None)
    if target:
        for route in reversed(srv.get("routes") or []):
            route["@id"] = f"storygapboard_route_{route_n}"
            route_n += 1
            if call("PUT", f"/config/apps/http/servers/{target}/routes/0", route)[0] != 200:
                sys.exit(1)
    else:
        srv["@id"] = f"storygapboard_server_{server_n}"
        if not current and server_n == 0:
            ok = call("PUT", "/config/apps/http", {"servers": {f"storygapboard_{server_n}": srv}})[0] == 200 \
                or call("POST", "/config/apps/http/servers", {f"storygapboard_{server_n}": srv})[0] == 200
        else:
            ok = call("PUT", f"/config/apps/http/servers/storygapboard_{server_n}", srv)[0] == 200
        if not ok:
            sys.exit(1)
        server_n += 1
EOF
}

caddy_api_present() {
	local admin
	admin="$(cat "$ROOT/.run/caddy-admin" 2>/dev/null || true)"
	[ -n "$admin" ] || return 1
	PY -c "
import sys, urllib.request
for name in ('storygapboard_route_0', 'storygapboard_server_0'):
    try:
        urllib.request.urlopen('http://$admin/id/' + name, timeout=5)
        sys.exit(0)
    except Exception:
        pass
sys.exit(1)"
}

caddy_api_remove() {
	local admin
	admin="$(cat "$ROOT/.run/caddy-admin" 2>/dev/null || true)"
	[ -n "$admin" ] || return 0
	PY -c "
import urllib.request
for prefix in ('storygapboard_route_', 'storygapboard_server_'):
    for i in range(100):
        try:
            urllib.request.urlopen(urllib.request.Request('http://$admin/id/%s%d' % (prefix, i), method='DELETE'), timeout=5)
        except Exception:
            break" 2>/dev/null || true
	rm -f "$ROOT/.run/caddy-admin" "$ROOT/.run/caddy-site.json"
}

caddy_sudo_import() {
	local cf backup
	cf="$(caddy_file)"
	make_snippet_readable || return 1
	backup="$ROOT/.run/Caddyfile.backup.$(date +%Y%m%d%H%M%S)"
	as_root cat "$cf" > "$backup" || return 1
	say "Adding one import line to $cf (backup: $backup)"
	printf '\n# StoryGapBoard (added by its deploy.sh)\nimport %s\n' "$ROOT/$SERVICE.caddy" | sudo -n tee -a "$cf" >/dev/null || return 1
	if caddy_adapt "$cf" >/dev/null 2>&1 && caddy_reload; then
		return 0
	fi
	warn "Caddy rejected the change: restoring $cf"
	sudo -n tee "$cf" < "$backup" >/dev/null && caddy_reload || true
	return 1
}

# Docker: keep this app's site in a marked block of the Caddyfile the
# container mounts (edited in place, so file bind mounts keep working), then
# let the container's own Caddy reload it. Restores the backup on failure.
caddy_docker_apply() { # port
	local block cur new backup
	block="# BEGIN storygapboard (managed by its deploy.sh; do not edit)
$(site_block "$(env_value SITE_ADDRESS)" "$1" "$APP_HOST" "$SITE_CF")
# END storygapboard"
	cur="$(as_root cat "$CADDY_HOSTFILE")" || return 1
	new="$(printf '%s' "$cur" | PY -c "
import re, sys
text = sys.stdin.read()
text = re.sub(r'\n*# BEGIN storygapboard.*?# END storygapboard\n?', '\n', text, flags=re.S).rstrip()
print(text + '\n\n' + sys.argv[1])" "$block")"
	[ "$new" = "$cur" ] && return 0
	backup="$ROOT/.run/Caddyfile.backup.$(date +%Y%m%d%H%M%S)"
	printf '%s\n' "$cur" > "$backup"
	say "Updating this app's block in $CADDY_HOSTFILE (container $CADDY_CTR_NAME; backup: $backup)"
	printf '%s\n' "$new" | as_root tee "$CADDY_HOSTFILE" >/dev/null || return 1
	if "${DOCKER[@]}" exec "$CADDY_CTR" caddy reload --config "$CADDY_CONF" --adapter caddyfile >/dev/null 2>&1; then
		return 0
	fi
	warn "Caddy (container $CADDY_CTR_NAME) rejected the change: restoring $CADDY_HOSTFILE"
	as_root tee "$CADDY_HOSTFILE" < "$backup" >/dev/null
	"${DOCKER[@]}" exec "$CADDY_CTR" caddy reload --config "$CADDY_CONF" --adapter caddyfile >/dev/null 2>&1 || true
	return 1
}

# The container must reach the app on the Docker gateway; a host firewall
# commonly blocks that. Open only this port, only from Caddy's Docker network:
# ufw when it is active, else one tagged iptables rule (re-checked every minute
# by the watchdog, since plain iptables rules do not survive a reboot).
container_reaches_app() { # port
	"${DOCKER[@]}" exec "$CADDY_CTR" wget -q -T 5 -O /dev/null "http://$APP_HOST:$1/api/health" >/dev/null 2>&1
}

docker_reachability() { # port [quiet]
	container_reaches_app "$1" && return 0
	if command -v ufw >/dev/null 2>&1 && as_root ufw status 2>/dev/null | grep -q "Status: active"; then
		[ -n "${2:-}" ] || say "Allowing $TRUSTED -> $APP_HOST:$1 in ufw (Caddy's Docker network only)"
		as_root ufw allow from "$TRUSTED" to "$APP_HOST" port "$1" proto tcp comment storygapboard >/dev/null 2>&1 || true
		container_reaches_app "$1" && return 0
	fi
	if command -v iptables >/dev/null 2>&1 && as_root iptables -L INPUT -n >/dev/null 2>&1; then
		local rule=(INPUT -s "$TRUSTED" -d "$APP_HOST" -p tcp --dport "$1" -m comment --comment storygapboard -j ACCEPT)
		if ! as_root iptables -C "${rule[@]}" 2>/dev/null; then
			[ -n "${2:-}" ] || say "Allowing $TRUSTED -> $APP_HOST:$1 in iptables (Caddy's Docker network only)"
			as_root iptables -I "${rule[@]}" 2>/dev/null || true
		fi
		container_reaches_app "$1" && return 0
	fi
	return 1
}

configure_caddy() { # port
	local applied="$ROOT/.run/caddy.sha256" want
	case "$CADDY_MODE" in
		import)
			caddy_api_remove
			want="$(file_hash "$ROOT/$SERVICE.caddy")"
			[ "$(cat "$applied" 2>/dev/null || true)" = "$want" ] && return 0  # unchanged: leave Caddy alone
			caddy_adapt "$(caddy_file)" >/dev/null 2>&1 \
				|| die "The Caddy config does not parse with this site block; Caddy was NOT reloaded."
			say "Reloading Caddy (graceful; Caddy keeps the old config if this fails)"
			if caddy_reload; then printf '%s\n' "$want" > "$applied"
			else warn "Could not reload Caddy; the site keeps its previous Caddy configuration."; fi
			;;
		sudo-import)
			caddy_api_remove
			if caddy_sudo_import; then printf '%s\n' "$(file_hash "$ROOT/$SERVICE.caddy")" > "$applied"; return 0; fi
			CADDY_MODE=api
			configure_caddy "$1"
			;;
		api)
			if caddy_api_apply; then
				say "Registered the site in Caddy through its admin API (re-applied automatically if Caddy reloads)"
				printf 'api\n' > "$ROOT/.run/caddy-mode"
			else
				CADDY_MODE=manual
			fi
			;;
		own)
			if own_caddy_apply; then
				say "This app's Caddy is serving the site (installed by deploy.sh; the server had none)"
			else
				CADDY_MODE=manual
			fi
			;;
		docker)
			if caddy_docker_apply "$1"; then
				printf 'docker\n' > "$ROOT/.run/caddy-mode"
				docker_reachability "$1" || warn "Caddy's container cannot reach the app at $APP_HOST:$1 (a firewall other than ufw/iptables?). See the report below."
			else
				CADDY_MODE=manual
			fi
			;;
	esac
	case "$CADDY_MODE" in api|docker|own) ;; *) rm -f "$ROOT/.run/caddy-mode" ;; esac
}

caddy_recent_errors() { # last TLS/ACME problems in the Caddy log (IPs masked: public logs)
	{
		case "$CADDY_MODE" in
			own) if [ "$(cat "$ROOT/.run/supervisor" 2>/dev/null)" = systemd ]; then journalctl --user -u "$SERVICE-caddy" -n 300 --no-pager 2>/dev/null
			     else tail -n 300 "$ROOT/.run/caddy.log" 2>/dev/null; fi ;;
			docker) "${DOCKER[@]}" logs --tail 300 "$CADDY_CTR" 2>&1 ;;
			*) as_root journalctl -u caddy -n 300 --no-pager 2>/dev/null ;;
		esac
	} | grep -iE '"level":"(error|warn)"|error|challenge|could not get certificate|obtain' \
		| grep -iE 'acme|certificate|challenge|tls|obtain|validat' | tail -n 6 \
		| sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/<ip>/g; s/([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}/<ip>/g' | cut -c1-400
}

# Always printed at the end of a deploy: what was found and whether the site
# answers through Caddy. Read-only. Never prints the server's public IP (the
# Actions logs of a public repository are public).
caddy_report() { # port
	local host resolved code="" http_code="" i
	host="$(site_host)"
	say "Report:"
	[ "$CADDY_MODE" = own ] && CADDY_KIND="own (installed by deploy.sh in $ROOT/tools)"
	printf '    caddy: %s%s%s%s\n' "$CADDY_KIND" "${CADDY_PID:+ (pid $CADDY_PID)}" "${CADDY_CTR_NAME:+, container $CADDY_CTR_NAME}" "${CADDY_CONF:+, config $CADDY_CONF}"
	[ -n "$CADDY_HOSTFILE" ] && printf '    caddyfile on the host: %s\n' "$CADDY_HOSTFILE"
	printf '    mode: %s; app listens on %s:%s\n' "$CADDY_MODE" "$APP_HOST" "$1"
	if command -v ss >/dev/null 2>&1; then
		printf '    listening on 80/443: %s\n' "$( (as_root ss -ltnpH '( sport = :80 or sport = :443 )' 2>/dev/null || ss -ltnH '( sport = :80 or sport = :443 )' 2>/dev/null) \
			| awk '{print $4, $6}' | sed 's/users:((//; s/,pid=.*//' | sort -u | tr '\n' ';' )"
	fi
	if [ -n "$host" ] && [ "$host" != "${host#*[a-zA-Z]}" ]; then
		resolved="$(PY -c "import socket,sys; print(' '.join(sorted({a[4][0] for a in socket.getaddrinfo(sys.argv[1], None)})))" "$host" 2>/dev/null || echo "does not resolve")"
		if [ "${SITE_CF:-0}" = 1 ]; then
			printf '    DNS: proxied by Cloudflare (%s). Visitor IPs come from CF-Connecting-IP; the origin answers HTTPS (SSL mode Full / Full strict) and plain HTTP (Flexible).\n' "$resolved"
		else
			printf '    DNS %s -> %s\n' "$host" "$resolved"
		fi
		if command -v curl >/dev/null 2>&1 && [ "$CADDY_MODE" != manual ]; then
			# Certificates can take a little while: wait up to 90 s.
			for i in $(seq 1 18); do
				if [[ "$(env_value SITE_ADDRESS)" == http://* ]]; then
					code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host:80:127.0.0.1" "http://$host/api/health" 2>/dev/null || true)"
				else
					code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host:443:127.0.0.1" "https://$host/api/health" 2>/dev/null || true)"
				fi
				[ "$code" = 200 ] && break
				sleep 5
			done
			printf '    the site through this server'"'"'s Caddy: %s\n' "${code:-no answer}"
			if [ "${SITE_CF:-0}" = 1 ]; then
				http_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$host:80:127.0.0.1" "http://$host/api/health" 2>/dev/null || true)"
				printf '    plain http through this server'"'"'s Caddy (for Cloudflare Flexible): %s\n' "${http_code:-no answer}"
			fi
			if [ "$code" != 200 ]; then
				printf '    recent Caddy certificate errors:\n'
				caddy_recent_errors | sed 's/^/      /' || true
			fi
		fi
	fi
	if [ "$CADDY_MODE" = manual ]; then
		if [ -n "${CADDY_PROBLEM:-}" ]; then warn "Site not published: $CADDY_PROBLEM."
		else case "$CADDY_KIND" in
			docker) warn "Caddy runs in container ${CADDY_CTR_NAME:-$CADDY_CTR}, but ${DOCKER_PROBLEM:-it could not be configured}." ;;
			host) warn "Caddy runs on the host but neither its CLI nor its admin API is usable, and there is no passwordless sudo." ;;
			*) warn "Site not published: no usable Caddy." ;;
		esac; fi
	fi
}

# --- Releases -----------------------------------------------------------------

switch_current() { # release dir (atomic rename when GNU mv is available)
	ln -sfn "$1" "$ROOT/current.new"
	if ! mv -T "$ROOT/current.new" "$ROOT/current" 2>/dev/null; then
		rm -f "$ROOT/current.new"
		ln -sfn "$1" "$ROOT/current"
	fi
}

prune_releases() {
	local keep cur
	cur="$(readlink -f "$ROOT/current" 2>/dev/null || true)"
	# Newest first; keep KEEP_RELEASES and always the current one.
	ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +"$((KEEP_RELEASES + 1))" | while read -r keep; do
		[ "$(readlink -f "$keep")" = "$cur" ] || rm -rf "$keep"
	done
}

lock_or_wait() {
	mkdir -p "$ROOT/.run"
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$ROOT/.run/deploy.lock"
		flock -w 900 9 || die "Another deploy is still running."
	fi
}

release_up() { # state sha
	ROOT="$1"
	CODE="$ROOT/releases/$2"
	[ -f "$CODE/deploy.sh" ] || die "Release $2 is missing."
	lock_or_wait
	check_server_basics
	prepare_env
	local port previous current_port
	port="$(env_value APP_PORT 8787)"
	ensure_python            # only touches tools/ and .venv/ of this app
	caddy_preflight "$port"  # finds the running Caddy; sets APP_HOST/TRUSTED
	# Pre-flight: the port may be busy only if it is this app holding it.
	current_port=""
	if app_running; then current_port="$(app_port_running)"; [ -n "$current_port" ] || current_port="$port"; fi
	if [ "$port" != "$current_port" ] && { port_in_use "$port" || port_in_use "$port" "$APP_HOST"; }; then
		die "Port $port is already used by another app. Set a free DEPLOY_APP_PORT. Nothing was changed."
	fi
	choose_supervisor
	previous="$(readlink "$ROOT/current" 2>/dev/null || true)"
	say "Activating release ${2:0:7}"
	switch_current "$CODE"
	restart_app "$port"
	if ! wait_healthy "$port"; then
		show_app_log
		if [ -n "$previous" ] && [ -d "$previous" ] && [ "$previous" != "$CODE" ]; then
			warn "The new release is not healthy: rolling back to $(basename "$previous")"
			switch_current "$previous"
			restart_app "$port"
			wait_healthy "$port" && die "Deploy failed; the previous release is running again." \
				|| die "Deploy failed and the previous release did not come back either."
		fi
		die "The app did not become healthy on $APP_HOST:$port."
	fi
	configure_caddy "$port"
	prune_releases
	say "Deployed: $(site_url "$(env_value SITE_ADDRESS)")  (release ${2:0:7}, app on $APP_HOST:$port, supervisor: $SUPERVISOR, caddy: $CADDY_MODE)"
	caddy_report "$port"
}

# Every minute (systemd timer or cron): keep the app up (cron mode) and the
# Caddy route present (API mode). Skips while a deploy is running.
supervise() { # state
	ROOT="$1"
	[ -d "$ROOT/current" ] || exit 0
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$ROOT/.run/deploy.lock"
		flock -n 9 || exit 0
	fi
	if [ "$(cat "$ROOT/.run/supervisor" 2>/dev/null)" = cron ] && [ -z "$(cron_app_pid || true)" ]; then
		cron_start_app
	fi
	if [ -f "$ROOT/.run/app.log" ] && [ "$(stat -c %s "$ROOT/.run/app.log" 2>/dev/null || echo 0)" -gt 10485760 ]; then
		tail -c 1048576 "$ROOT/.run/app.log" > "$ROOT/.run/app.log.tmp" && mv "$ROOT/.run/app.log.tmp" "$ROOT/.run/app.log"
	fi
	case "$(cat "$ROOT/.run/caddy-mode" 2>/dev/null)" in
		api)
			if ! caddy_api_present; then caddy_discover; caddy_api_apply || true; fi ;;
		own)
			if [ "$(cat "$ROOT/.run/supervisor" 2>/dev/null)" = cron ] && [ -z "$(own_caddy_pid || true)" ] && [ -x "$(own_caddy_bin)" ]; then
				own_caddy_start_cron
			fi
			open_web_ports quiet ;;
		docker)
			read -r APP_HOST TRUSTED < "$ROOT/.run/net" 2>/dev/null || true
			caddy_discover
			if [ "$CADDY_KIND" = docker ] && docker_access; then
				docker_reachability "$(cat "$ROOT/.run/port" 2>/dev/null || echo 8787)" quiet || true
			fi ;;
	esac
}

# --------------------------------------------------------------------------
# Bootstrap (CI): this script arrives on stdin over SSH. Resolve the project
# folder (creating it when needed), unpack the release package of the tested
# commit, then run that release's own deploy.sh. Never touches a non-empty
# folder that does not belong to StoryGapBoard.
# --------------------------------------------------------------------------

expand_path() { # ~, relative (to $HOME) and trailing slashes
	local p
	p="$(trim "$1")"
	case "$p" in
		"~") p="$HOME" ;;
		"~/"*) p="$HOME/${p#"~/"}" ;;
		/*) ;;
		*) p="$HOME/$p" ;;
	esac
	printf '%s' "${p%/}"
}

bootstrap() { # path sha package package_sha256  (settings arrive in SGB_ENV)
	local path sha pkg pkg_sha rel
	path="$(expand_path "${1:-}")"
	sha="$(trim "${2:-}")"
	pkg="$(expand_path "${3:-}")"
	pkg_sha="$(trim "${4:-}")"
	[ -n "${1:-}" ] || die "The project path (DEPLOY_PATH) is empty."
	[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "Invalid commit id from CI."
	check_server_basics
	[ -f "$pkg" ] || die "The release package did not arrive: $pkg"
	[ "$(file_hash "$pkg")" = "$pkg_sha" ] || die "The release package is corrupted (checksum mismatch)."
	if [ -e "$path" ] && [ ! -d "$path" ]; then
		die "$path exists and is not a folder."
	fi
	if [ -d "$path" ] && [ -n "$(ls -A "$path" 2>/dev/null)" ] && [ ! -f "$path/.storygapboard" ] \
		&& ! { [ -f "$path/deploy.sh" ] && [ -f "$path/backend/app/main.py" ]; }; then
		die "$path is not empty and does not belong to StoryGapBoard; refusing to touch it. Use an empty or new folder."
	fi
	if ! mkdir -p "$path" 2>/dev/null || [ ! -w "$path" ]; then
		if can_sudo; then
			say "Creating $path with sudo (owned by $(id -un))"
			sudo -n mkdir -p "$path" && sudo -n chown "$(id -un):$(id -gn)" "$path"
		fi
		[ -d "$path" ] && [ -w "$path" ] || die "User $(id -un) cannot create or write $path (and has no passwordless sudo). Use a folder inside $HOME in DEPLOY_PATH."
	fi
	touch "$path/.storygapboard"
	rel="$path/releases/$sha"
	if [ ! -f "$rel/deploy.sh" ]; then
		say "Unpacking release ${sha:0:7}"
		rm -rf "$rel.tmp"
		mkdir -p "$rel.tmp"
		tar -xzf "$pkg" -C "$rel.tmp"
		rm -rf "$rel"
		mv "$rel.tmp" "$rel"
	fi
	rm -f "$pkg"
	chmod +x "$rel/deploy.sh"
	# Environment, not arguments: other users on the server can read process
	# arguments, but not another user's environment.
	export SGB_ENV="${SGB_ENV:-}"
	# stdin is this script itself (bash -s): never let the deploy read from it.
	exec "$rel/deploy.sh" release-up "$path" "$sha" < /dev/null
}

# --------------------------------------------------------------------------
# Optional helpers on the server: PATH/current/deploy.sh production <action>
# --------------------------------------------------------------------------

production() { # action
	local here
	here="$(cd "$(dirname "$0")" && pwd -P)"
	[ "$(basename "$(dirname "$here")")" = releases ] \
		|| die "Production deploys run from GitHub Actions. On the server use: <DEPLOY_PATH>/current/deploy.sh production status|logs|restart|stop"
	ROOT="$(dirname "$(dirname "$here")")"
	SUPERVISOR="$(cat "$ROOT/.run/supervisor" 2>/dev/null || echo systemd)"
	case "$1" in
		status) if app_running; then echo "running ($SUPERVISOR)"; else echo "stopped ($SUPERVISOR)"; fi ;;
		logs) if [ "$SUPERVISOR" = systemd ]; then journalctl --user -u "$SERVICE" -f -n 200; else tail -n 200 -f "$ROOT/.run/app.log"; fi ;;
		restart) if [ "$SUPERVISOR" = systemd ]; then systemctl_user restart "$SERVICE"; else cron_stop_app; cron_start_app; fi ;;
		stop) if [ "$SUPERVISOR" = systemd ]; then systemctl_user stop "$SERVICE"; else remove_cron; cron_stop_app; fi ;;
		*) usage 1 ;;
	esac
}

main() {
	case "${1:-}" in
		local) ROOT="$(cd "$(dirname "$0")" && pwd)"; run_local ;;
		bootstrap) bootstrap "${2:-}" "${3:-}" "${4:-}" "${5:-}" ;;
		release-up) release_up "${2:-}" "${3:-}" ;;
		supervise) supervise "${2:-}" ;;
		production) production "${2:-status}" ;;
		-h|--help|help|"") usage 0 ;;
		*) usage 1 ;;
	esac
}

# Everything runs from main(), so replacing this file cannot change a run midway.
main "$@"
exit
