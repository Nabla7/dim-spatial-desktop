#!/bin/sh
# Development: copy the working tree's page and manifest into Desktop's install of this app.
rsync -a --delete frontend/ "$HOME/.dimos/apps/dim-spatial-desktop/frontend/" && cp dimos.yaml icon.svg "$HOME/.dimos/apps/dim-spatial-desktop/"
