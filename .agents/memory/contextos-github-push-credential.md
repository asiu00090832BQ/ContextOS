---
name: ContextOS GitHub push credential broken
description: Replit's git-transport credential to GitHub can fail UNAUTHENTICATED while GitHub API auth (repo creation) still works; push via a user PAT.
---

# Replit GitHub push credential can be broken independently of API auth

Symptom: every push to the GitHub remote (the `subrepl-*` whose URL is `https://github.com/...`)
fails with `Invalid username or token` / `UNAUTHENTICATED` / "Failed to authenticate with the
remote" — from BOTH the agent shell (`replit-git-askpass`) and the Replit Git pane. Yet Replit
can still *create* GitHub repos, and the connected account passes re-auth + repo-access checks.

**Why:** repo creation uses GitHub **API/OAuth** auth, but `git push` uses a separate **git-transport
credential** (the token handed to git over HTTPS). The transport credential was broken in this
workspace while the API path was fine — so "account connected" and "push works" are independent gates.

**Diagnostic that pins it down:** Git pane "Publish branch" → `BRANCH_ALREADY_EXISTS` is a *local
pre-check* in Replit's own branch metadata (fails before any network call); the real network push
("Push/Sync") returns the auth error. So a non-auth pane error is NOT proof auth works.

**How to apply / workaround that actually completes a push:** have the user create a fine-grained
GitHub PAT (Contents: Read/Write on the target repo), store it as a Replit **secret** (it lands in
the shell env). Push with a temporary askpass so the token never hits argv/output:
```
# /tmp/gpush-askpass:  Username* -> "x-access-token";  * -> "$GITHUB_PERSONAL_ACCESS_TOKEN"
GIT_ASKPASS=/tmp/gpush-askpass GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= push <remote> main:main
```
Validate the token first via `curl -H "Authorization: Bearer $TOK" https://api.github.com/repos/<o>/<r>`
(check `"push": true`). After pushing, refresh the local tracking ref with `git update-ref`.

**Note on remote-tracking prune:** pruning the GitHub remote-tracking ref (to "forget" deleted
branches) clears local main's upstream → the pane flips from "Push" to "Publish" mode, which then
collides with stale `BRANCH_ALREADY_EXISTS` metadata. Restore upstream with `git update-ref
refs/remotes/<remote>/main <sha>` + `git branch --set-upstream-to` to get normal push mode back.
