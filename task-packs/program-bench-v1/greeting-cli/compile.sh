#!/bin/sh
set -eu
node --check program.mjs
cp program.mjs executable
chmod +x executable
