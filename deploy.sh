#!/usr/bin/env bash
# StoryGapBoard: the single deploy script. Runs natively (no Docker).
#
#   ./deploy.sh local                         build and run on http://localhost:8080 (Ctrl+C stops)
#   ./deploy.sh production [up|status|logs|stop|restart]
#                                             deploy on a server that may already host other apps
#   deploy.sh bootstrap PATH REPO_URL [SHA]   (CI, script sent over SSH) create/clone PATH if
#                                             needed, then deploy exactly commit SHA from there
#
# It only creates/updates files that belong to this app: the project folder
# (.venv, frontend build, data/, .env, storygapboard.caddy) and its own user
# service (~/.config/systemd/user/storygapboard.service). It never installs
# system packages, never edits the main Caddyfile and never touches other apps:
# Caddy is reloaded only when this app's site block changes (and keeps its old
# config if the reload fails).
set -euo pipefail

SERVICE=storygapboard
LOCAL_PORT="${LOCAL_PORT:-8080}"
MIN_PYTHON="3.10"
HEALTH_TIMEOUT_S=60

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
	if [ -f "$0" ]; then sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; fi
	exit "${1:-0}"
}

# --------------------------------------------------------------------------
# .env (parsed, never sourced: it is data, not code)
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

# --------------------------------------------------------------------------
# Dependencies: verified, never installed system-wide
# --------------------------------------------------------------------------

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

check_dependencies() { # mode
	local missing=()
	find_python || missing+=("Python >= $MIN_PYTHON with venv: sudo apt install python3 python3-venv")
	if [ -n "${PYTHON_BIN:-}" ] && ! "$PYTHON_BIN" -c "import venv, ensurepip" 2>/dev/null; then
		missing+=("Python venv module: sudo apt install python3-venv (or python3.X-venv)")
	fi
	node_ok || missing+=("Node.js 20.19+ or 22.12+ with npm: https://nodejs.org (or your distro's nodejs)")
	if [ "$1" = production ]; then
		command -v git >/dev/null 2>&1 || missing+=("git: sudo apt install git")
		command -v systemctl >/dev/null 2>&1 || missing+=("systemd (systemctl)")
	fi
	if [ ${#missing[@]} -gt 0 ]; then
		printf '\033[1;31mMissing dependencies\033[0m (install them, then run again):\n' >&2
		printf '  - %s\n' "${missing[@]}" >&2
		exit 1
	fi
	say "Dependencies OK: $("$PYTHON_BIN" --version), Node $(node --version)"
}

# --------------------------------------------------------------------------
# Build (identical for local and production)
# --------------------------------------------------------------------------

file_hash() { "$PYTHON_BIN" -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$1"; }

setup_backend() {
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

prepare_data_dir() {
	mkdir -p "$ROOT/data"
	chmod 700 "$ROOT/data"
}

# The same uvicorn command for local and production (only host/port differ).
uvicorn_args() { # host port
	printf '%s ' app.main:app --host "$1" --port "$2" --workers 1 \
		--proxy-headers --forwarded-allow-ips 127.0.0.1 \
		--no-server-header --no-access-log --timeout-keep-alive 5 --limit-concurrency 200
}

# This app's Caddy site block (also used locally when Caddy is installed).
site_block() { # address upstream_port
	cat <<EOF
# Generated by deploy.sh for StoryGapBoard. Do not edit: changes are overwritten.
$1 {
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
	reverse_proxy 127.0.0.1:$2 {
		flush_interval -1
	}
}
EOF
}

# Healthy = THIS app answers on the port (another app answering 200 does not count).
wait_healthy() { # port
	local waited=0
	until "$ROOT/.venv/bin/python" -c "
import json, urllib.request
base = 'http://127.0.0.1:$1'
assert json.load(urllib.request.urlopen(base + '/api/health', timeout=2)) == {'ok': True}
assert 'layouts' in json.load(urllib.request.urlopen(base + '/api/meta', timeout=2))
" 2>/dev/null; do
		[ "$waited" -ge "$HEALTH_TIMEOUT_S" ] && return 1
		sleep 1
		waited=$((waited + 1))
	done
}

port_in_use() { # port
	"$PYTHON_BIN" -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1', int(sys.argv[1])))==0 else 1)" "$1"
}

# --------------------------------------------------------------------------
# Local: same build and same server command, in the foreground
# --------------------------------------------------------------------------

run_local() {
	check_dependencies local
	setup_backend
	build_frontend
	prepare_data_dir
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

# --------------------------------------------------------------------------
# Production: user-level systemd service + this app's Caddy site block
# --------------------------------------------------------------------------

systemctl_user() {
	# SSH sessions (e.g. GitHub Actions) may lack the user bus variables.
	export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
	export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
	systemctl --user "$@"
}

# Update the checkout, then re-run the (possibly updated) script. From CI
# (SGB_DEPLOY_SHA) it moves to exactly the commit tested by that run, even if
# the branch already has newer, untested commits; by hand it fast-forwards to
# the upstream branch. Local changes on the server are never discarded.
update_code() {
	[ "${SGB_SKIP_PULL:-}" = 1 ] && return 0
	git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
	git -C "$ROOT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || return 0
	git -C "$ROOT" fetch --quiet
	local sha="${SGB_DEPLOY_SHA:-}"
	if [ -n "$sha" ]; then
		[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "Invalid commit id from CI: $sha"
		git -C "$ROOT" merge-base --is-ancestor "$sha" '@{u}' 2>/dev/null \
			|| die "Commit $sha is not on the deployed branch; refusing to deploy it."
		say "Moving the code to the tested commit $(git -C "$ROOT" rev-parse --short "$sha")"
		# --keep moves the branch (forwards or back) and aborts instead of losing local changes.
		git -C "$ROOT" reset --quiet --keep "$sha" || die "Local changes on the server block the update; fix the checkout first."
	else
		say "Updating the code (fast-forward only)"
		git -C "$ROOT" merge --ff-only --quiet '@{u}' || die "Local changes block a fast-forward update; fix the checkout first."
	fi
	SGB_SKIP_PULL=1 exec "$0" "$@"
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

# CI settings (SGB_ENV: "KEY=value" lines from the DEPLOY_<KEY> secrets and
# variables) are the source of truth: they create .env on the first deploy and
# overwrite a key whenever its value differs. Keys CI does not send are left as
# they are. Everything is validated before .env is touched; values are never
# printed (some are secret), only the names of the keys that changed.
sync_env_from_ci() {
	[ -n "${SGB_ENV:-}" ] || return 0
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
	done <<< "$SGB_ENV"
	if [ ! -f "$ROOT/.env" ]; then
		say "Creating .env from .env.example"
		cp "$ROOT/.env.example" "$ROOT/.env"
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

prepare_production_env() {
	sync_env_from_ci
	[ -f "$ROOT/.env" ] || die "Missing .env in $ROOT. Either set DEPLOY_SITE_ADDRESS in GitHub (CI creates .env), or run there: cp .env.example .env  and set SITE_ADDRESS to your domain."
	local site
	site="$(env_value SITE_ADDRESS)"
	[ -n "$site" ] && [ "$site" != "example.com" ] || die "Set SITE_ADDRESS in .env to the domain of this app."
	valid_site "$site" || die "SITE_ADDRESS in .env has invalid characters; use just the domain, e.g. app.example.com"
	if [ -z "$(env_value LOG_HASH_SALT)" ]; then
		say "Generating LOG_HASH_SALT in .env"
		set_env_value LOG_HASH_SALT "$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
	fi
	chmod 600 "$ROOT/.env"
}

require_linger() {
	if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || echo no)" != yes ]; then
		die "The service must keep running after you log out. Run once (as an admin):
    sudo loginctl enable-linger $(id -un)
then run ./deploy.sh production again."
	fi
}

install_service() { # port
	local unit_dir="$HOME/.config/systemd/user" unit
	unit="$(cat <<EOF
# Generated by deploy.sh for StoryGapBoard. Do not edit: changes are overwritten.
[Unit]
Description=StoryGapBoard web app
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/backend
EnvironmentFile=-$ROOT/.env
Environment=DATA_DIR=$ROOT/data
Environment=FRONTEND_DIST=$ROOT/frontend/dist
Environment=PYTHONUNBUFFERED=1
ExecStart=$ROOT/.venv/bin/uvicorn $(uvicorn_args 127.0.0.1 "$1")
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
UMask=0077
MemoryMax=1G
TasksMax=256

[Install]
WantedBy=default.target
EOF
)"
	mkdir -p "$unit_dir"
	if [ "$(cat "$unit_dir/$SERVICE.service" 2>/dev/null || true)" != "$unit" ]; then
		say "Writing $unit_dir/$SERVICE.service"
		printf '%s\n' "$unit" > "$unit_dir/$SERVICE.service"
		systemctl_user daemon-reload
	fi
	systemctl_user enable --quiet "$SERVICE"
}

# Caddy must be able to read the snippet as its own user, or a future Caddy
# restart would fail for EVERY site. Prints the blocking folder, if any.
caddy_can_read() { # file
	"$PYTHON_BIN" - "$1" <<'EOF'
import os, stat, sys
path = os.path.abspath(sys.argv[1])
if not os.stat(path).st_mode & stat.S_IROTH:
    print(path)
    sys.exit(1)
d = os.path.dirname(path)
while True:
    if not os.stat(d).st_mode & stat.S_IXOTH:
        print(d)
        sys.exit(1)
    if d == "/":
        break
    d = os.path.dirname(d)
EOF
}

# Before anything is (re)started: write this app's site block and make sure
# Caddy can use it. Sets CADDY_MODE to: absent | not-imported | ready.
caddy_preflight() { # port
	local snippet="$ROOT/$SERVICE.caddy" caddyfile new blocked
	caddyfile="$(env_value CADDYFILE /etc/caddy/Caddyfile)"
	new="$(site_block "$(env_value SITE_ADDRESS)" "$1")"
	if [ "$(cat "$snippet" 2>/dev/null || true)" != "$new" ]; then
		printf '%s\n' "$new" > "$snippet"
	fi
	chmod 644 "$snippet"
	if ! command -v caddy >/dev/null 2>&1; then
		CADDY_MODE=absent
		return 0
	fi
	if ! blocked="$(caddy_can_read "$snippet")"; then
		die "Caddy's own user cannot read $snippet ($blocked is not readable/traversable by others).
Fix with: chmod o+x $blocked   (or keep the project under /srv). Nothing was changed."
	fi
	if grep -qF "$snippet" "$caddyfile" 2>/dev/null || \
	   caddy adapt --config "$caddyfile" --adapter caddyfile 2>/dev/null | grep -q "127.0.0.1:$1"; then
		CADDY_MODE=ready
	else
		CADDY_MODE=not-imported
	fi
}

configure_caddy() { # port
	local snippet="$ROOT/$SERVICE.caddy" caddyfile
	caddyfile="$(env_value CADDYFILE /etc/caddy/Caddyfile)"
	case "$CADDY_MODE" in
		absent)
			warn "Caddy was not found on this host. Add the site block in $snippet to your proxy so it reaches 127.0.0.1:$1."
			return 0 ;;
		not-imported)
			warn "Your Caddy config does not include this app yet. Add this line ONCE at the end of $caddyfile:
    import $snippet
then run ./deploy.sh production again."
			return 0 ;;
	esac
	local applied="$ROOT/.run/caddy.sha256" want
	mkdir -p "$ROOT/.run"
	want="$(file_hash "$snippet")"
	if [ "$(cat "$applied" 2>/dev/null || true)" = "$want" ]; then
		return 0  # unchanged: leave Caddy (and the other sites) alone
	fi
	caddy adapt --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1 \
		|| die "The Caddy config does not parse with this site block; Caddy was NOT reloaded. Check: caddy adapt --config $caddyfile"
	say "Reloading Caddy (graceful; Caddy keeps the old config if this fails)"
	if caddy reload --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1; then
		printf '%s\n' "$want" > "$applied"
	else
		warn "Could not reload Caddy from this user (admin API off?). Run: sudo systemctl reload caddy"
	fi
}

production() { # action
	local port
	case "$1" in
		status) systemctl_user status "$SERVICE" --no-pager; return ;;
		logs) journalctl --user -u "$SERVICE" -f -n 200; return ;;
		stop) systemctl_user stop "$SERVICE"; return ;;
		restart) systemctl_user restart "$SERVICE"; return ;;
		up) ;;
		*) usage 1 ;;
	esac
	update_code production up
	check_dependencies production
	prepare_production_env
	require_linger
	port="$(env_value APP_PORT 8787)"
	[[ "$port" =~ ^[0-9]+$ ]] || die "APP_PORT in .env must be a number."
	# Pre-flight checks first: on failure nothing has been built or restarted.
	# The port may be busy only if it is this app's running service holding it.
	local current_port=""
	if systemctl_user is-active --quiet "$SERVICE"; then
		current_port="$(sed -n 's/^ExecStart=.* --port \([0-9]*\) .*/\1/p' "$HOME/.config/systemd/user/$SERVICE.service" 2>/dev/null || true)"
	fi
	if [ "$port" != "$current_port" ] && port_in_use "$port"; then
		die "Port $port is already used by another app. Set a free APP_PORT in .env. Nothing was changed."
	fi
	caddy_preflight "$port"
	setup_backend
	build_frontend
	prepare_data_dir
	install_service "$port"
	say "Restarting the $SERVICE service"
	systemctl_user restart "$SERVICE"
	if ! wait_healthy "$port"; then
		journalctl --user -u "$SERVICE" -n 40 --no-pager >&2 || true
		die "The app did not become healthy on 127.0.0.1:$port."
	fi
	configure_caddy "$port"
	local site
	site="$(env_value SITE_ADDRESS)"
	[[ "$site" == *://* ]] || site="https://$site"
	say "Deployed: $site  (app on 127.0.0.1:$port)"
}

# --------------------------------------------------------------------------
# Bootstrap (CI): this script arrives over SSH, so the project folder may not
# exist yet. Resolve the path, clone the repository when needed, then run the
# project's own deploy.sh. Never overwrites a folder that is not our checkout.
# --------------------------------------------------------------------------

trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }

bootstrap() { # path repo_url [sha]  (settings arrive in SGB_ENV, never as arguments)
	local path repo sha
	path="$(trim "${1:-}")"
	repo="$(trim "${2:-}")"
	sha="$(trim "${3:-}")"
	[ -n "$path" ] || die "The project path (DEPLOY_PATH) is empty."
	case "$path" in
		"~") path="$HOME" ;;
		"~/"*) path="$HOME/${path#"~/"}" ;;
		/*) ;;
		*) path="$HOME/$path" ;;  # relative paths are relative to the deploy user's home
	esac
	path="${path%/}"
	command -v git >/dev/null 2>&1 || die "git is not installed on the server: sudo apt install git"
	if [ -f "$path/deploy.sh" ] && git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
		say "Using the existing checkout in $path"
	elif [ -e "$path" ] && [ ! -d "$path" ]; then
		die "$path exists and is not a folder."
	elif [ -d "$path" ] && [ -n "$(ls -A "$path" 2>/dev/null)" ]; then
		die "$path is not empty and is not a StoryGapBoard checkout; refusing to touch it. Use an empty or new folder."
	else
		[ -n "$repo" ] || die "No repository URL to clone from."
		mkdir -p "$path" 2>/dev/null && [ -w "$path" ] || die "User $(id -un) cannot create or write $path. Ask an admin once:
    sudo mkdir -p $path && sudo chown $(id -un): $path"
		say "Cloning $repo into $path"
		git clone --quiet "$repo" "$path" || die "git clone failed."
	fi
	[ -x "$path/deploy.sh" ] || chmod +x "$path/deploy.sh"
	cd "$path"
	# Environment, not arguments: other users on the server can read process
	# arguments, but not another user's environment.
	export SGB_ENV="${SGB_ENV:-}" SGB_DEPLOY_SHA="$sha"
	# stdin is this script itself (bash -s): never let the deploy read from it.
	exec ./deploy.sh production up < /dev/null
}

main() {
	case "${1:-}" in
		local|production) ROOT="$(cd "$(dirname "$0")" && pwd)" ;;
	esac
	case "${1:-}" in
		local) run_local ;;
		production) production "${2:-up}" ;;
		# Arrives over SSH on stdin: it has no folder of its own (yet).
		bootstrap) bootstrap "${2:-}" "${3:-}" "${4:-}" ;;
		-h|--help|help|"") usage 0 ;;
		*) usage 1 ;;
	esac
}

# Everything runs from main(), so a code update cannot change the script mid-run.
main "$@"
exit
