#!/usr/bin/env bash
# Print the commit a Hermes image release is built from and tagged at.
#
#   release-commit.sh [ref]
#
# Run from a clone that has origin/main. The bot's coverage commit (subject
# "chore: update coverage badge and baseline [skip ci]") is never released: it
# starts no CI, so a tag on it has no tested code of its own. With no ref, the
# answer is the newest commit on origin/main that is not such a commit. With a
# ref (a branch, tag or SHA), the answer is that commit, or an error when it is
# a coverage commit.
set -euo pipefail

badge='chore: update coverage badge and baseline [skip ci]'

if [ -n "${1:-}" ]; then
  commit=$(git rev-parse --verify "$1^{commit}")
  if [ "$(git log -1 --format=%s "$commit")" = "$badge" ]; then
    echo "::error::$commit is a coverage badge commit; give the last code commit instead" >&2
    exit 1
  fi
  echo "$commit"
  exit 0
fi

while read -r commit subject; do
  if [ "$subject" != "$badge" ]; then
    echo "$commit"
    exit 0
  fi
done < <(git log --format='%H %s' origin/main)
echo "::error::no code commit on origin/main" >&2
exit 1
