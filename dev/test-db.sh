#!/usr/bin/env bash
# Throwaway MySQL for developing Quarry. Not for real data.
#   host 127.0.0.1  port 3399  user root  password quarry-dev
# Usage: dev/test-db.sh [up|seed|down]
set -euo pipefail
NAME=quarry-test-mysql
cmd=${1:-up}
case "$cmd" in
  up)
    docker run -d --name "$NAME" -p 127.0.0.1:3399:3306 \
      -e MYSQL_ROOT_PASSWORD=quarry-dev mysql:8.4 >/dev/null
    echo "waiting for mysqld..."
    until docker exec "$NAME" mysqladmin ping -uroot -pquarry-dev --silent 2>/dev/null; do sleep 1; done
    sleep 3
    "$0" seed
    ;;
  seed)
    docker exec -i "$NAME" mysql -uroot -pquarry-dev < "$(dirname "$0")/seed.sql"
    echo "seeded schema 'shop'"
    ;;
  down)
    docker rm -f "$NAME"
    ;;
esac
