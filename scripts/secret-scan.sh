#!/bin/sh
# Pre-publish scan: fails if any value from .env appears outside .env, in the tree or in git history.
set -e
fail=0
for key in PAYPAL_CLIENT_SECRET PAYPAL_CLIENT_ID NVIDIA_API_KEY ANTHROPIC_API_KEY PAYPAL_WEBHOOK_ID INTERNAL_ACTION_KEY; do
  v=$(grep "^$key=" .env 2>/dev/null | cut -d= -f2-); [ -z "$v" ] && continue
  if grep -rIlF --exclude-dir=node_modules --exclude-dir=.git --exclude=.env -- "$v" . | grep -q .; then echo "LEAK in tree: $key"; fail=1; fi
  if git rev-parse HEAD >/dev/null 2>&1 && git log --all -p -S"$v" --oneline | grep -q .; then echo "LEAK in git history: $key"; fail=1; fi
done
git ls-files --error-unmatch .env >/dev/null 2>&1 && { echo ".env is tracked!"; fail=1; }
[ $fail -eq 0 ] && echo "secret scan: clean" || exit 1
