# Launch TODO

Goal: ship a credible first version as soon as possible without letting launch prep expand the product scope.

Working assumption: the first release is the chat-only MVP described in [Chat-Only MVP Scope](chat-only-mvp.md). Non-chat workflows, hosted API-provider setup, debate/consensus modes, and broader automation surfaces are future work unless explicitly pulled back into the MVP.

## P0: Launch Blockers

These items should be finished before any public launch or paid beta.

### Product Definition

- [ ] Choose the app name.
  - [ ] Produce a shortlist and rank candidates.
  - [ ] Check obvious trademark, domain, App Store, GitHub, and search conflicts.
  - [ ] Pick the final product name and tagline.
  - [ ] Update app metadata, package names, window title, docs, and visible UI copy.
- [ ] Define the desired MVP.
  - [ ] Confirm whether [Chat-Only MVP Scope](chat-only-mvp.md) is the launch scope.
  - [ ] Write a one-paragraph product promise for the first release.
  - [ ] List the exact first-run workflow a new user must complete successfully.
  - [ ] Mark every current feature as `ship`, `hide`, `polish`, or `defer`.
- [ ] Align implementation with the desired MVP.
  - [ ] Hide or remove non-MVP navigation and legacy workflows.
  - [ ] Ensure the default user path starts in chat setup, not a legacy mode.
  - [ ] Verify local CLI participants work without hosted API-provider configuration.
  - [ ] Verify role presets, saved participants, permissions, and chat history match the MVP contract.
  - [ ] Confirm old settings or conversations do not break the MVP path.

### Brand And UI

- [ ] Create the app logo.
  - [ ] Design the primary app icon.
  - [ ] Export required macOS/Electron icon sizes.
  - [ ] Add light/dark-safe logo usage where needed.
- [ ] Refine UI design.
  - [ ] Tighten the first-run and new-chat flow.
  - [ ] Polish empty, loading, running, success, warning, and error states.
  - [ ] Review all visible copy for clarity and consistent naming.
  - [ ] Check keyboard behavior, focus states, scrolling, and small-window layout.
  - [ ] Verify settings screens are understandable without internal implementation terms.
- [ ] Create onboarding and help basics.
  - [ ] Add a concise first-run explanation of what the app does.
  - [ ] Explain required local CLI dependencies and permissions.
  - [ ] Add a minimal troubleshooting path for missing CLIs, denied permissions, and failed runs.

### Quality And Release Readiness

- [ ] QA the MVP.
  - [ ] Run `make typecheck`.
  - [ ] Run `make build`.
  - [ ] Smoke-test creating a chat with Codex CLI.
  - [ ] Smoke-test creating a chat with Claude Code, if installed.
  - [ ] Smoke-test mentioning one participant and multiple participants.
  - [ ] Smoke-test participant add requests and user approval.
  - [ ] Smoke-test role editing, saved participant editing, and permission changes.
  - [ ] Smoke-test reopening chat history after app restart.
  - [ ] Smoke-test missing or disabled CLI states.
  - [ ] Smoke-test fresh install behavior with no existing settings.
- [ ] Prepare desktop distribution.
  - [ ] Confirm packaging target and installer format.
  - [ ] Configure production app identity, bundle ID, icons, and versioning.
  - [ ] Sign and notarize the macOS build if distributing outside local development.
  - [ ] Verify the downloaded app launches cleanly on a fresh machine.
  - [ ] Decide how users receive updates after install.
- [ ] Add basic privacy and security materials.
  - [ ] Document what data is stored locally.
  - [ ] Document what may be sent to local CLI agents and their configured providers.
  - [ ] Add privacy policy and terms if collecting payments, analytics, crash reports, or emails.
  - [ ] Review logs and exported diagnostics for sensitive prompt, diff, or key leakage.

## P1: Commercial Launch

These items are needed for a serious paid launch, but some can follow a small private beta.

### Website

- [ ] Create the website.
  - [ ] Landing page with product promise, screenshots, use cases, and CTA.
  - [ ] Download or waitlist flow.
  - [ ] Pricing page, if paid at launch.
  - [ ] Privacy policy and terms pages.
  - [ ] Support/contact page.
  - [ ] Basic SEO metadata and social preview images.

### Monetization

- [ ] Define monetization strategy.
  - [ ] Choose free, paid upfront, subscription, trial, or private beta pricing.
  - [ ] Define what is paid versus free.
  - [ ] Define launch discount or early-access offer, if any.
  - [ ] Decide refund policy and support expectations.
- [ ] Implement purchases.
  - [ ] Choose payment provider.
  - [ ] Implement checkout.
  - [ ] Implement license, entitlement, or account activation.
  - [ ] Handle expired, refunded, canceled, and offline states.
  - [ ] Add purchase receipts, billing emails, and support recovery path.
  - [ ] QA purchase flows in test mode and production mode.

### Growth And Feedback

- [ ] Define promotion strategy.
  - [ ] Pick launch audience and first user segment.
  - [ ] Prepare launch messaging and demo assets.
  - [ ] Identify launch channels: direct outreach, communities, Product Hunt, Hacker News, X/LinkedIn, newsletters, or partners.
  - [ ] Prepare a short demo video or animated walkthrough.
  - [ ] Build a list of beta users and early reviewers.
- [ ] Add feedback and support loops.
  - [ ] Add an in-app feedback or support link.
  - [ ] Create a public support email or form.
  - [ ] Decide how bugs and feature requests are triaged.
  - [ ] Track known issues and release notes.
- [ ] Define launch metrics.
  - [ ] Decide the activation event.
  - [ ] Track downloads, installs, activated chats, retained users, purchases, and refunds.
  - [ ] Decide whether analytics are local-only, opt-in, or external.
  - [ ] Make analytics privacy-safe before collecting anything.

## P2: Soon After Launch

- [ ] Add automated tests around chat creation, settings validation, participant permissions, and storage migrations.
- [ ] Add crash reporting or a manual diagnostics export.
- [ ] Add a public changelog.
- [ ] Add update checks or auto-update if distribution requires it.
- [ ] Create product docs for common workflows.
- [ ] Build a post-launch roadmap from real user feedback.

## Launch Exit Criteria

The app is launch-ready when:

- [ ] A new user can understand the product, install it, start a chat, add participants, and get useful responses without help.
- [ ] The MVP scope is explicit and the UI does not advertise unfinished features.
- [ ] Build, packaging, signing, and installation are repeatable.
- [ ] There is a clear path for payment, support, privacy, and updates.
- [ ] The launch page explains what the app does and why someone should try it.
- [ ] There is a concrete promotion plan for the first 100 users.
