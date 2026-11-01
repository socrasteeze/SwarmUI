#!/bin/sh
# Self-check for scan-sensitive.sh and the pre-push hook, in a throwaway repo. Values are built from pieces so
# this file does not trip the scanner it tests.
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d) || exit 2
trap 'rm -rf "$work"' EXIT
cd "$work" || exit 2
git init -q -b main repo
git init -q --bare remote.git
cd repo || exit 2
git config user.name socrasteeze
git config user.email socradeez@gmail.com
git config core.autocrlf false
git config core.hooksPath "$root/.githooks"
mkdir scripts
cp "$root/scripts/scan-sensitive.sh" scripts/
echo scripts >> .git/info/exclude
echo base > base.txt
git add base.txt
git commit -qm base
git remote add origin ../remote.git
git push -q origin main >/dev/null || { echo 'FAIL: the first clean push was refused'; exit 1; }

failed=0
expect() {
    if [ "$2" = "$3" ]; then
        echo "PASS  $1"
    else
        echo "FAIL  $1 (wanted $2, got $3)"
        failed=1
    fi
}
scan() {
    sh scripts/scan-sensitive.sh >/dev/null 2>&1
    echo $?
}
# Commits one line, scans it, then drops the commit.
blocks() {
    echo "$2" > value.txt
    git add value.txt
    git commit -qm 'add value'
    expect "$1" 1 "$(scan)"
    git reset -q --hard origin/main
}
private=192.168
cgnat=100.100
generated='Generated with'
tool='Claude Code'
blocks 'a private address is blocked' "url $private.1.2"
blocks 'a CGNAT address is blocked' "url $cgnat.1.2"
blocks 'a key is blocked, and a line starting with a dash is scanned' "-----BEGIN OPENSSH ""PRIVATE KEY-----"
blocks 'a tailnet host is blocked' "box.tail1234.ts"".net"
blocks 'a user path is blocked' 'C:\Users''\someone\file'
blocks 'a generated-with line is blocked' "$generated $tool"

echo 'version 10.0.103 and 127.0.0.1 and http://fixture.local/ and model.local' > value.txt
git add value.txt
git commit -qm 'ordinary text'
expect 'version numbers, loopback, and the fixture host pass' 0 "$(scan)"
git reset -q --hard origin/main

echo 'NotARealName' > .git/info/sensitive-words
blocks 'a word on the private list is blocked' 'by NotARealName today'
echo 'name NotARealName' > listed.txt
git add listed.txt
git commit -qm 'add' --no-verify
git push -q --no-verify origin main
git rm -q listed.txt
git commit -qm 'remove the listed word'
expect 'removing a listed word passes' 0 "$(scan)"
git reset -q --hard origin/main
: > .git/info/sensitive-words

echo x > m.txt
git add m.txt
git commit -qm "$(printf 'add\n\nCo-authored-by: Some Bot <b@example.com>')"
expect 'an AI trailer is blocked' 1 "$(scan)"
git reset -q --hard origin/main

git -c user.name=Bot -c user.email=b@example.com commit -q --allow-empty -m 'wrong author'
expect 'a foreign identity is blocked' 1 "$(scan)"
git reset -q --hard origin/main

echo "url $private.5.6" > untracked.txt
expect 'an untracked file is scanned' 1 "$(scan)"
rm untracked.txt

echo "url $private.5.6" > upstream.txt
git add upstream.txt
git -c user.name=Upstream -c user.email=u@example.com commit -qm 'upstream work'
git update-ref refs/remotes/upstream/master HEAD
expect 'upstream commits are not scanned' 0 "$(scan)"
git update-ref -d refs/remotes/upstream/master
git reset -q --hard origin/main

echo "url $private.7.8" > hook.txt
git add hook.txt
git commit -qm 'hook test'
git push -q origin main >/dev/null 2>&1
expect 'the pre-push hook refuses a bad push' 1 "$?"
expect 'the refused commit did not reach the remote' "$(git rev-parse origin/main)" "$(git ls-remote origin refs/heads/main | cut -f1)"
git reset -q --hard origin/main
echo fine > hook.txt
git add hook.txt
git commit -qm 'clean work'
git push -q origin main >/dev/null 2>&1
expect 'the pre-push hook allows a clean push' 0 "$?"
exit "$failed"
