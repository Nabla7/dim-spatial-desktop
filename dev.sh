#!/bin/sh
# Development against the Desktop on this machine.
#
#   ./dev.sh hot       Desktop runs the server and serves the page straight from this working tree.
#                      A saved file under frontend/ reaches every open page by itself (src/update.js).
#   ./dev.sh restart   after a change under server/ or to dimos.yaml: copy the manifest, restart the server
#   ./dev.sh release   back to what is committed: Desktop pulls this branch and builds it
#
# Desktop reads dimos.yaml from its own install of the app, never from here. A route or a gateway call
# that is only in this tree's dimos.yaml is refused (HTTP 403) until `restart` copies the file over.
set -e
app=dim-spatial-desktop
here=$(cd "$(dirname "$0")" && pwd)
install="$HOME/.dimos/apps/$app"
desktop="${DIMOS_DESKTOP_URL:-http://127.0.0.1:5555}"
[ -d "$install" ] || { echo "$app is not installed: dimos-desktop install $here --name $app --ref main"; exit 1; }

restart() {
  cp "$here/dimos.yaml" "$install/dimos.yaml"
  pkill -f "$here/server/main.ts" 2>/dev/null || true
  curl -fsS -X POST "$desktop/gateways/desktop/management/apps/$app/reload" >/dev/null && echo "restarted $app"
}

case "${1:-}" in
  hot)
    deno=$(command -v deno) || { echo "deno is needed on PATH for hot mode"; exit 1; }
    mkdir -p "$install/hot/bin"
    printf '#!/bin/sh\n# Development: run the server and the page straight from the working tree.\nexec %s run -A --no-lock --no-remote %s/server/main.ts --frontend %s/frontend "$@"\n' "$deno" "$here" "$here" > "$install/hot/bin/dimos-app-server"
    chmod +x "$install/hot/bin/dimos-app-server"
    rm -f "$install/result" && ln -s "$install/hot" "$install/result"
    restart ;;
  restart) restart ;;
  release)
    pkill -f "$here/server/main.ts" 2>/dev/null || true
    rm -rf "$install/hot" "$install/.result-nix"
    git -C "$install" checkout -q -- . 2>/dev/null || true
    dimos-desktop update "$app" ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
