## Auto-Push

Auto-push mode is permanently ON for this project. After every code change:
1. Run `git status --short` and `git log origin/$(git branch --show-current)..HEAD --oneline`
2. If the auto-commit hook already pushed → confirm and move on
3. Stage and commit any uncommitted changes (excluding `.env`, `*.key`, `*.secret`, `*credentials*`) with a one-line present-tense summary, appending `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
4. Run `git push` (or `git push --set-upstream origin <branch>` if no upstream)
5. End every response with one line: "Pushed to origin/<branch>"

Never force-push. Never skip pre-commit hooks. Never commit secrets.
