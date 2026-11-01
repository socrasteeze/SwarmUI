#!/bin/sh
# The gate half of /clean: finds AI attribution, foreign identities, secrets and private infrastructure in
# outgoing work. Upstream's commits are never scanned, and removed lines never count.
#
#   scripts/scan-sensitive.sh                 commits not on origin/main, plus uncommitted and untracked files
#   scripts/scan-sensitive.sh <tip> <remote>  commits in <tip> not in <remote> (the pre-push hook's call)
#
# Private names and hostnames go one per line in .git/info/sensitive-words, so they are never committed.
# shortcut: reads text only, so EXIF and text inside images are missed; /clean still reviews those by hand.
cd "$(git rev-parse --show-toplevel)" || exit 2
tip=${1:-HEAD}
exclude=
for ref in "${2:-origin/main}" refs/remotes/upstream/master; do
    if git rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; then
        exclude="$exclude $ref"
    fi
done
text=$(mktemp) || exit 2
kept=$(mktemp) || exit 2
words=$(mktemp) || exit 2
trap 'rm -f "$text" "$kept" "$words"' EXIT
# Message lines are indented by 4, which keeps a "- item" in a message from reading as a removed line.
# shellcheck disable=SC2086
git log "$tip" --not $exclude --cc -U0 --format='COMMIT %h%nIDENTITY %an <%ae>%nIDENTITY %cn <%ce>%n%w(0,4,4)%B' > "$text" || exit 2
if [ $# -eq 0 ]; then
    git diff HEAD -U0 >> "$text" || exit 2
    git -c core.quotePath=off ls-files -o --exclude-standard | while IFS= read -r file; do
        echo "+++ b/$file"
        sed 's/^/+/' "$file"
    done >> "$text"
fi
# Hunk headers quote old code, so they go with the removed lines. A merge's combined diff has two marker
# columns, so a removed line starts "-" or " -". "+-" is an added line whose text starts with a dash.
LC_ALL=C grep -avE '^(@@|-| -)' "$text" > "$kept"

found=0
report() {
    if [ -n "$2" ]; then
        echo "BLOCKED: $1"
        echo "$2" | cut -c1-160 | head -n 5
        found=1
    fi
}
search() {
    LC_ALL=C grep -a "$@" "$kept"
}
report 'commit identity is not socrasteeze' "$(search '^IDENTITY ' | grep -avE '^IDENTITY socrasteeze <(socradeez@gmail\.com|141272628\+socrasteeze@users\.noreply\.github\.com)>')"
report 'AI attribution' "$(search -iE '^    (co-authored-by|generated-by|assisted-by):|^    signed-off-by:.*(claude|anthropic|openai|copilot|cursor)|generated (with|by) .*(claude|chatgpt|copilot|cursor)|noreply@anthropic[.]com')"
report 'secret' "$(search -E 'BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|xox[abp]-[0-9A-Za-z-]{10,}')"
report 'private network address' "$(search -E '(^|[^0-9.])(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(\.[0-9]{1,3}){2})($|[^0-9.])')"
report 'private host name' "$(search -E '\.ts\.net|https?://[^/ ]*\.(local|lan|internal|home\.arpa)([:/ "]|$)' | grep -av '//fixture\.local')"
report 'personal path' "$(search -E '[A-Za-z]:\\+Users\\+[A-Za-z]|/Users/[A-Za-z]')"
list=$(git rev-parse --git-path info/sensitive-words)
if [ -f "$list" ]; then
    grep -v '^[[:space:]]*$' "$list" > "$words"
    if [ -s "$words" ]; then
        report 'word from .git/info/sensitive-words' "$(search -F -w -f "$words")"
    fi
fi
if [ "$found" != 0 ]; then
    echo 'Nothing was pushed. Run /clean, fix the findings, and try again.'
    exit 1
fi
echo 'scan-sensitive: clean'
