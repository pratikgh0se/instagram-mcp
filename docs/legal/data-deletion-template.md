# Data deletion instructions template (self-hosted instagram-mcp)

This is a template, not legal advice. Meta requires a public "Data deletion instructions URL" before an app can go Live; a static page that explains how to delete data is enough (a callback endpoint is optional). Copy everything below the line into a page you host (see [docs/SETUP.md](../SETUP.md), "Go Live"), replace every `<PLACEHOLDER>`, and delete this introduction.

---

# Data deletion instructions

Last updated: <DATE>

The Meta app "<APP NAME>" is a private tool run by <YOUR NAME OR BUSINESS NAME> on their own computer. All data it holds is stored locally on that computer and nowhere else.

## If you connected your own account to the app

1. Remove the app's access to your account:
   - Instagram: Settings, Apps and websites (or Website permissions), find "<APP NAME>", and remove it.
   - Facebook: Settings, Business integrations, find "<APP NAME>", and remove it.
2. Delete the local data. On the computer that runs the app, quit the app and daemon, then run `rm -rf ~/.instagram-mcp` (or the folder named by `INSTAGRAM_MCP_HOME`). This removes the local database, downloaded media and staged files.
3. Delete the stored tokens: remove the `instagram-mcp` items in the macOS keychain (Keychain Access) or delete `secrets.enc.json`, which lives in the folder from step 2.
4. Optional: delete the app itself in the Meta App Dashboard (App settings, Advanced, Delete app).

## If you wrote to or commented on an account that uses the app

The app may hold a local copy of your public comments or the direct messages you sent to the account. Email <CONTACT EMAIL> from the address linked to your request, with your Instagram username, and ask for deletion. Records will be deleted within <NUMBER> days and you will get a confirmation. You can also delete your own comments and messages in Instagram.

## Contact

<YOUR NAME>, <CONTACT EMAIL>
