#!/bin/bash
# Rewrites relative ".js" import specifiers to ".ts" in packages/* and apps/worker (see scripts/check-specifiers.mjs).
cd "$(dirname "$0")/.."
find packages apps/worker -type f \( -name '*.ts' -o -name '*.tsx' \) -not -path '*/node_modules/*' -not -path '*/drizzle/*' -print0 \
 | xargs -0 grep -lE 'from "\.{1,2}/[^"]+\.js"|import\("\.{1,2}/[^"]+\.js"\)' 2>/dev/null \
 | while IFS= read -r f; do sed -i '' -E 's#(from "\.{1,2}/[^"]+)\.js"#\1.ts"#g; s#(import\("\.{1,2}/[^"]+)\.js"\)#\1.ts")#g' "$f"; echo "fixed $f"; done
