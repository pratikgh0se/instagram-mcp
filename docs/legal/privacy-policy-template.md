# Privacy policy template (self-hosted instagram-mcp)

This is a template, not legal advice. Meta requires a public privacy policy URL before an app can go Live. Copy everything below the line into a page you host (see [docs/SETUP.md](../SETUP.md), "Go Live"), replace every `<PLACEHOLDER>`, and change anything that is not true for your setup. Delete this introduction from the published page. Meta's rules for the page (public, crawlable, not geoblocked, your own, says how people ask for deletion) are at https://developers.facebook.com/documentation/development/terms-and-policies/privacy-policy.md (fetched 2026-11-01).

---

# Privacy policy

Last updated: <DATE>

This policy covers the Meta app "<APP NAME>" (the "app"), operated by <YOUR NAME OR BUSINESS NAME> ("I", "me"). The app is a private tool that I run on my own computer to manage my own Instagram professional account. It is not offered to the public and has no sign-up.

## Who this applies to

- Me, the operator, and the Instagram account(s) that I own or manage and have connected to the app.
- People who write to or comment on those accounts. The app can read those comments and messages, because Instagram delivers them to the account owner.

## What data the app accesses

Through Meta's official Instagram Platform API, and only with the permissions I granted: my account profile and media, comments and mentions on my posts, insights for my account, and direct messages sent to my account (message text, sender id and timestamp). The app only touches accounts that I have configured in it.

## Where the data goes

The data is stored only on my own computer, in a local folder (`~/.instagram-mcp`): a local database with the operation log, scheduled posts, insight snapshots and inbox state, plus any media I download. Access tokens are kept in my operating system's keychain or an encrypted local file. Nothing is sent to a server run by me or by any third party, and nothing is sold, shared or used for advertising. The only outside party that receives requests from the app is Meta (Instagram and Facebook), under Meta's own terms. If I use an AI assistant with the app, the data I ask it to read is processed by that assistant under its provider's terms.

## How long it is kept

Until I delete it. Webhook and inbox records are pruned automatically after a retention period set in the app's local configuration.

## Your choices and deletion requests

If you wrote to or commented on my account and want data about you removed from my local copy, follow the instructions at <DATA DELETION PAGE URL> or email <CONTACT EMAIL>. I will delete it within <NUMBER> days. You can also delete your own comments and messages on Instagram directly.

If you are an account owner who connected the app, you can remove its access at any time in Instagram (Settings, Apps and websites) or Facebook (Settings, Business integrations). See the data deletion page for the full steps.

## Contact

<YOUR NAME>, <CONTACT EMAIL>

## Changes

I will update this page if the app changes how it handles data and change the date above.
