#!/usr/bin/env bash
# StoryGapBoard: the single deploy script.
#
#   ./deploy.sh local [up|down|logs|status]       full production stack on http://localhost:8080
#   ./deploy.sh production [up|down|logs|status]  build and (re)start on this server (needs .env)
#
# Both targets build the same images and run the same docker-compose.yml
# (app + Caddy); local only swaps the domain for plain HTTP on 127.0.0.1.
# Requires Docker with the compose plugin.
set -euo pipefail

LOCAL_PORT="${LOCAL_PORT:-8080}"
HEALTH_TIMEOUT_S=120

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
	sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
	exit "${1:-0}"
}

compose() { docker compose -p "$PROJECT" "$@"; }

require_docker() {
	command -v docker >/dev/null 2>&1 || die "Docker is not installed."
	docker compose version >/dev/null 2>&1 || die "The Docker compose plugin is missing."
	docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (is it running? are you in the docker group?)."
}

wait_healthy() {
	local id status waited=0
	id="$(compose ps -q app)"
	[ -n "$id" ] || die "The app container did not start. See: ./deploy.sh $TARGET logs"
	say "Waiting for the app health check..."
	while :; do
		status="$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null || echo unknown)"
		[ "$status" = healthy ] && break
		[ "$waited" -ge "$HEALTH_TIMEOUT_S" ] && die "The app is not healthy after ${HEALTH_TIMEOUT_S}s (status: $status)."
		sleep 2
		waited=$((waited + 2))
	done
}

# .env values are read by compose; make sure production has the essentials.
prepare_production_env() {
	[ -f .env ] || die "Missing .env. Run: cp .env.example .env  and set SITE_ADDRESS to your domain."
	local site
	site="$(grep -E '^SITE_ADDRESS=' .env | tail -n1 | cut -d= -f2- | tr -d '"'"'"' ')"
	[ -n "$site" ] && [ "$site" != "example.com" ] || die "Set SITE_ADDRESS in .env to your real domain."
	if ! grep -qE '^LOG_HASH_SALT=.+' .env; then
		say "Generating LOG_HASH_SALT in .env"
		local salt
		salt="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
		if grep -qE '^LOG_HASH_SALT=' .env; then
			sed -i.bak "s/^LOG_HASH_SALT=.*/LOG_HASH_SALT=$salt/" .env && rm -f .env.bak
		else
			printf '\nLOG_HASH_SALT=%s\n' "$salt" >> .env
		fi
	fi
	chmod 600 .env
}

# Production pulls the latest code first, then re-runs the NEW script.
update_code() {
	[ "${SGB_SKIP_PULL:-}" = 1 ] && return 0
	git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 0
	git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || return 0
	say "Updating the code (fast-forward only)"
	git fetch --quiet
	git merge --ff-only --quiet '@{u}' || die "Local changes block a fast-forward update; fix the checkout first."
	SGB_SKIP_PULL=1 exec "$0" "$@"
}

# The app must resolve openrouter.ai from inside its container.
app_has_dns() {
	compose exec -T app python -c "import socket; socket.getaddrinfo('openrouter.ai', 443)" >/dev/null 2>&1
}

check_dns() {
	app_has_dns && return 0
	if [ "$TARGET" = local ] && [ -z "${APP_DNS:-}" ]; then
		say "Containers cannot resolve DNS here (a Docker network may overlap your DNS servers); using 1.1.1.1"
		export APP_DNS=1.1.1.1
		compose up -d app
		wait_healthy
		app_has_dns && return 0
	fi
	printf '\033[1;33mwarning:\033[0m the app container cannot resolve openrouter.ai; generations will fail.\n' >&2
	printf '         Set APP_DNS (e.g. APP_DNS=1.1.1.1) in .env or the environment and run again.\n' >&2
}

up() {
	say "Building images"
	compose build --pull
	say "Starting the stack"
	compose up -d --remove-orphans
	# Single-file bind mounts pin the old inode: recreate Caddy so Caddyfile
	# edits always apply (certificates persist in the caddy-data volume).
	compose up -d --force-recreate --no-deps caddy
	wait_healthy
	check_dns
	docker image prune -f >/dev/null 2>&1 || true
}

main() {
	cd "$(dirname "$0")"
	TARGET="${1:-}"
	local action="${2:-up}"
	case "$TARGET" in
		local)
			PROJECT=storygapboard-local
			export SITE_ADDRESS=":80" BIND_ADDRESS=127.0.0.1 HTTP_PORT="$LOCAL_PORT" HTTPS_PORT="$((LOCAL_PORT + 1))"
			;;
		production)
			PROJECT=storygapboard
			;;
		-h|--help|help|"") usage 0 ;;
		*) usage 1 ;;
	esac
	require_docker
	case "$action" in
		up)
			if [ "$TARGET" = production ]; then
				update_code "$@"
				prepare_production_env
			fi
			up
			if [ "$TARGET" = local ]; then
				say "Running: http://localhost:$LOCAL_PORT  (stop with: ./deploy.sh local down)"
			else
				say "Deployed. Logs: ./deploy.sh production logs"
			fi
			;;
		down) compose down ;;
		logs) compose logs -f --tail=200 ;;
		status) compose ps ;;
		*) usage 1 ;;
	esac
}

# Everything runs from main(), so a code update cannot change the script mid-run.
main "$@"
exit
