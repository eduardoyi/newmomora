# Store submission answers

**Draft date:** July 16, 2026

**App:** UseMomora (`com.memora.app`)

**Release:** 1.1.0

**Audience:** Adults 18+ only

This is a console-entry draft, not proof that either store has been updated. Items marked **HUMAN CONFIRMATION REQUIRED** depend on the release binary, production configuration, provider contracts, or values visible only in App Store Connect or Play Console.

## Evidence snapshot

The draft reflects the current repository, Privacy Policy, and Terms of Service:

- The mobile dependency/config audit found no analytics, crash-reporting, advertising, attribution, App Tracking Transparency, IDFA, or in-app-purchase SDK.
- The website uses Google Tag Manager, but no equivalent analytics SDK is declared in the mobile app. Website-only GTM data is therefore excluded from the app declarations. Recheck the final native dependency graph before submission.
- Supabase provides authentication/database/functions; Cloudflare R2 stores private media; OpenAI processes requested AI and voice features; Expo/APNs/FCM deliver pushes; Bento delivers transactional email.
- Account and family data is stored against account/family identifiers. Photos, videos, journal text, comments, AI output, and most operational records are therefore linked to an account even though access is private.
- Voice audio is intended to be processed temporarily and discarded after transcription. Images are re-encoded before upload to remove EXIF/GPS; video-container metadata is not stripped.
- Account deletion is available in-app and through `https://usemomora.com/delete-account/`, with a 15-day grace period and limited safety/legal retention described in the Privacy Policy.

Apple requires declarations for data collected by the app or integrated third-party partners and defines collection as off-device transmission retained longer than needed to service the request in real time. It also says free-form text should normally be represented as **Other User Content**, while specifically requested photos, videos, and audio use their specific types. See [Apple's App Privacy Details definitions](https://developer.apple.com/app-store/app-privacy-details/) and [App Store Connect privacy workflow](https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy/).

Google defines collection more broadly as transmitting data off-device, including through SDKs, and requires ephemeral processing to be included in the form even when it is not displayed on the public label. Google also exempts qualifying service-provider, legal, user-initiated, and fully anonymous transfers from the definition of sharing. See [Google Play's Data safety definitions and form guidance](https://support.google.com/googleplay/android-developer/answer/10787469).

## 1. Apple App Privacy

### Top-level fields

| App Store Connect field | Draft answer |
|---|---|
| Privacy Policy URL | `https://usemomora.com/privacy-policy/` |
| User Privacy Choices URL | `https://usemomora.com/delete-account/` |
| Does this app collect data? | **Yes** |

**HUMAN CONFIRMATION REQUIRED:** Open both URLs from a logged-out browser, verify their published copy matches the release, and verify the final iOS archive contains no undeclared analytics, diagnostics, advertising, or purchase SDK.

### Data-type selections

For every selected type below, answer **Data Linked to the User: Yes** and **Used for Tracking: No**. Momora does not combine app data with third-party data for targeted advertising or advertising measurement and does not send it to data brokers. Apple's tracking definition is in [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/#tracking).

| Apple data type | Select | Purposes | Why |
|---|---:|---|---|
| Contact Info → Name | Yes | App Functionality | Account names and names/nicknames of people in a family journal. |
| Contact Info → Email Address | Yes | App Functionality | Authentication, reviewer access, account support, and transactional family-invite email. |
| Sensitive Info | Yes, conservative | App Functionality; Product Personalization | Child/family date of birth, gender, and potentially sensitive profile details are used for age-aware portraits/illustrations. Use the closest current console type. |
| User Content → Emails or Text Messages | Yes | App Functionality | Comments are private in-app group messages. Apple specifically says non-SMS private in-app messages belong here. |
| User Content → Photos or Videos | Yes | App Functionality; Product Personalization | Required family-profile photo, optional memory photos/videos, AI portrait inputs/outputs, and AI illustrations. |
| User Content → Audio Data | Yes, conservative | App Functionality | Optional voice recordings leave the device for transcription. See the transient-processing gate below. |
| User Content → Other User Content | Yes | App Functionality; Product Personalization | Memory text/captions, profile notes, report notes/reasons, links, generated prompts, and other free-form journal content. |
| Identifiers → User ID | Yes | App Functionality | Supabase account IDs, family membership attribution, and report/block ownership. |
| Identifiers → Device ID | Yes | App Functionality | Expo push token and device/app/network identifiers retained for delivery or abuse prevention. |
| Usage Data → Product Interaction | Yes | App Functionality | Likes, comments, invite/redeem actions, reports, blocks, notification preferences, and similar stored feature actions. |
| Diagnostics → Other Diagnostic Data | Yes, conservative | App Functionality | Limited request/error/status/device information used to operate, secure, and troubleshoot the service. |
| Other Data → Other Data Types | Yes, conservative | App Functionality; Product Personalization | Timezone, family roles/settings, notification settings, AI status/emotion labels, and safety-resolution metadata that do not cleanly fit another Apple type. |

Do **not** select these based on the audited app:

- Phone Number, Physical Address, Other User Contact Info
- Health, Fitness, Financial Info, Payment Info, Purchase History
- Precise Location or Coarse Location
- Contacts
- Browsing History or Search History
- Advertising Data
- Crash Data or Performance Data
- Environment Scanning, Hands, or Head

Clarifications:

- Do not declare location merely because infrastructure sees an IP address; Apple says to map IP collection according to how it is actually used. Momora uses it for request security/rate limiting, not location inference.
- Do not declare raw photo EXIF/GPS metadata: it is read on-device only to derive a date, and only the derived date is transmitted. Apple excludes data processed only on-device. The selected Photos/Videos and Other Data Types entries already cover the uploaded media and stored date.
- Do not declare mobile analytics or advertising because website GTM is not embedded in the mobile app.
- Do not select Purchases unless the final binary or backend restores purchase handling.

### Apple transient-processing gate

**HUMAN CONFIRMATION REQUIRED:** Confirm the production OpenAI account's retention setting and the complete voice request path. Apple says data immediately discarded after servicing a real-time request is not collected. If every party processes voice audio only for the live request and retains no readable copy, **Audio Data may be omitted**. If OpenAI, Supabase logging, or any other processor can retain readable audio beyond the request, keep **Audio Data** selected as linked, not tracked, for App Functionality. The conservative submission answer is to keep it selected.

### Apple purpose summary

Select no purpose for Third-Party Advertising, Developer's Advertising or Marketing, or Analytics. Use **Product Personalization** only for data actually used to tailor age-aware portraits, illustrations, emotion labels, or other user-specific output. Use **App Functionality** for authentication, private sharing, storage, security, moderation, support, notification delivery, and feature operation. Apple's purpose definitions appear in [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/#data-use).

## 2. Google Play Data Safety

### Top-level security and deletion answers

| Play Console field | Draft answer |
|---|---|
| Does the app collect or share user data? | **Yes** |
| Is all collected user data encrypted in transit? | **Yes** |
| Does the app provide a way to request data deletion? | **Yes** |
| Does the app allow account creation? | **Yes** |
| In-app account-deletion path | **Yes** — Settings → Delete account |
| Web account-deletion URL | `https://usemomora.com/delete-account/` |
| Can users request deletion of some data without deleting the account? | **Yes, if the current form asks this** — in-app deletion for role-permitted memories/profiles/comments plus `hello@usemomora.com` for privacy requests |
| Independent security review | **No** unless a current MASA/authorized-lab review has actually completed |
| Committed to Play Families Policy | **No** — adults 18+ only |

Google requires both an in-app account-deletion route and a web request resource when the app supports account creation. See [Google Play's account-deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111).

**HUMAN CONFIRMATION REQUIRED:** Verify every mobile-to-server endpoint in the final build uses transport encryption; verify the live deletion page and support inbox; and compare the exact deletion questions in the current console. Do not imply immediate deletion: the public policy says deletion is scheduled after a 15-day grace period and permits limited safety/legal retention.

### Data-type selections

Unless a row says otherwise, use:

- **Collected:** Yes
- **Shared:** No, conditional on the provider gate below
- **Processed ephemerally:** No

| Google data type | Required or optional | Collection purposes | Notes |
|---|---|---|---|
| Personal info → Name | Required | App functionality; Account management | Account name is required; family-profile names are core journal data. |
| Personal info → Email address | Required | App functionality; Account management | Required for authentication and account/reviewer access. |
| Personal info → User IDs | Required | App functionality; Account management; Fraud prevention, security, and compliance | Supabase/account and membership identifiers. |
| Personal info → Other info | Required, conservative | App functionality; Personalization | Device timezone is stored automatically; optional DOB/gender drive age-aware AI output. |
| Messages → Other in-app messages | Optional | App functionality | Household comments. |
| Photos and videos → Photos | Required | App functionality; Personalization | A first family-profile photo is required for the core onboarding/portrait flow. |
| Photos and videos → Videos | Optional | App functionality | User chooses whether to attach memory videos. |
| Audio files → Voice or sound recordings | Optional; **ephemeral: Yes** | App functionality | Voice input is processed in memory for transcription and not intentionally stored. |
| App activity → Other user-generated content | Optional | App functionality; Personalization; Fraud prevention, security, and compliance | Memory text/captions, profile notes, comments/report notes, links, and AI inputs/output metadata. |
| App activity → Other actions | Optional | App functionality; Fraud prevention, security, and compliance | Likes, invitations, reports, family-scoped block/unblock, role changes, and notification choices. |
| Device or other IDs → Device or other IDs | Required, conservative | App functionality; Fraud prevention, security, and compliance | Push token plus retained network/device identifiers used for delivery and rate limiting. |
| App info and performance → Diagnostics | Required, conservative | App functionality; Fraud prevention, security, and compliance | Limited request/error/status/device data used to operate and secure the service. |

Do **not** select these based on the audited app:

- Approximate or precise location
- Address, phone number, race/ethnicity, political/religious beliefs, sexual orientation
- Payment information, purchase history, credit score, other financial information
- Health or fitness
- Emails, SMS, or MMS
- Music or other audio files
- Files and documents, calendar events, contacts, installed apps
- App interactions for analytics, in-app search history, or web-browsing history
- Crash logs or Other app performance data

Notes on required/optional:

- Google says a type is optional only if all users can choose not to provide it or opt out. A profile photo is treated as required because the current core onboarding requires one; videos, voice, comments, report notes, and most actions remain optional.
- The **Other info**, **Device or other IDs**, and **Diagnostics** rows are intentionally conservative. **HUMAN CONFIRMATION REQUIRED:** inspect production request logging, Supabase/Expo behavior, and the final Android SDK manifest. If timezone is not transmitted, device/network identifiers are not retained, or no client diagnostics leave the device, narrow these rows rather than blindly publishing them.

### Google sharing/provider gate

The draft uses **Shared: No** because Supabase, Cloudflare R2, OpenAI, Expo/APNs/FCM, and Bento are described as processors operating on Momora's behalf; private household access is user-initiated; and legal disclosures fall under Google's listed exceptions. Google's exceptions are explained in [Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469#zippy=%2Cdata-sharing).

**HUMAN CONFIRMATION REQUIRED before submitting “not shared”:**

1. Verify current contracts/data-processing terms make every infrastructure vendor a service provider acting on Momora's instructions.
2. Verify none of those providers independently uses the data for advertising, profiling, model training, or another purpose outside Momora's instructions.
3. Review pasted-link title fetching. A saved URL is sent server-to-server to the destination website, which is not Momora's service provider. If a user would not reasonably expect that transfer or the saved URL can itself be personal data, either add an appropriate prominent disclosure/consent or mark the applicable **Other user-generated content** row as **Shared** for App functionality. Save the Data Safety form as a draft until this is resolved.
4. Verify no SDK or provider added after this audit transmits additional data.

### Retention and deletion wording

Use this when the console asks for an explanation:

> Momora provides in-app and web account-deletion requests. Deletion enters a 15-day grace period during which the account holder can cancel. When deletion completes, an owner's family journals and their associated content are deleted. In journals owned by someone else, shared content may remain without the deleted account's attribution, as described in the Privacy Policy. Voice audio is not intentionally retained after transcription. Minimal report/security records may be retained or de-identified only as needed for safety, abuse prevention, disputes, or legal obligations.

## 3. Apple age-rating questionnaire

Apple's current questionnaire separates in-app controls, capabilities, and content frequency. Apple's definitions say **Messaging and Chat** includes direct/group messaging or public posting, while **User-Generated Content** covers user-created media/text distributed as part of the app experience. See [Apple's current category definitions](https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions) and [age-rating setup instructions](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating).

### In-app controls and capabilities

| Questionnaire item | Draft answer | Rationale |
|---|---:|---|
| Parental Controls | No | No parent/guardian controls for a child's use; accounts are adult-only. |
| Age Assurance | No | Terms require 18+, but the app does not currently verify age through an age API, ID, or age-estimation system. |
| Unrestricted Web Access | No | Links open externally; the app is not a general-purpose browser. |
| User-Generated Content | Yes, conservative | Members create memories, media, profiles, and comments visible to a private household. |
| Messaging and Chat | Yes | Household comments are group communication. |
| Social Media | No | No public/discoverable feed, redistribution, follower graph, or amplification. |
| Social Media Disabled for Users Under 13 | No / Not applicable | The app has no social-media capability and targets only adults. |
| Advertising | No | No ad SDK or ads. |

### Content-frequency answers

Use **None** for every publisher-provided content descriptor unless the exact release's seeded reviewer content or store assets contain it:

- Profanity or crude humor
- Horror or fear themes
- Alcohol, tobacco, or drug references
- Mature or suggestive themes
- Medical or treatment information / health and wellness topics
- Sexual content or nudity
- Cartoon/fantasy or realistic violence; guns/weapons
- Simulated gambling, gambling, contests, and loot boxes

User-written free-form content is handled through the UGC capability answer, Terms, reporting/blocking, and moderation. Do not mark a descriptor **None** if Momora itself seeds, recommends, generates, or knowingly hosts that descriptor in the submitted review account.

### Age category and override

- **Made for Kids:** No.
- **Override to Higher Age Rating:** Yes.
- **Override value:** **18+** (or the current region-equivalent presented by App Store Connect).
- **Age Suitability URL:** Optional; use the Terms URL only if the console accepts it as an age-suitability explanation.

Apple states that when an app's EULA has a higher minimum age than the calculated rating, the developer must override to a rating that adheres to that requirement. Momora's Terms require users to be at least 18. See [Apple's override instructions](https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating#age-categories-and-override).

**HUMAN CONFIRMATION REQUIRED:** Apple may change labels or region-specific values. Answer the actual current prompts truthfully, preserve 18+ in the Terms/store copy, and verify the resulting region-by-region ratings before saving.

## 4. Google target audience and content

Google says developers should select only age groups the app is genuinely designed for, and selecting **18 and over** as the only group enables the separate **Restrict minor access** control. See [Google Play's target-audience instructions](https://support.google.com/googleplay/android-developer/answer/9867159/manage-target-audience-and-app-content-settings).

| Play Console field | Draft answer |
|---|---|
| Contains ads | No |
| Target age group | **18 and over only** |
| Restrict users Google has determined to be minors | **Yes** |
| Designed for children / includes children in target audience | **No** |
| Primarily appeals to children | **No** — adult private memory-journal workflow, adult account/Terms, no child-directed activities |
| Families program / badge | Do not enroll |

For the IARC/content questionnaire, answer feature facts rather than trying to force a particular rating:

- User-generated content: **Yes**.
- Online interaction / users communicate: **Yes** (private household comments).
- Public sharing, public social network, or discoverability: **No**.
- Digital purchases: **No**.
- Ads: **No**.
- Location sharing: **No**.
- Gambling, simulated gambling, loot boxes, violence, sexual content, drugs, and other publisher-provided mature content: **No**, unless the submitted binary/store assets actually contain it.

**HUMAN CONFIRMATION REQUIRED:** Cute family illustrations can look child-friendly without making children the target audience. Keep listing copy, screenshots, categories, and ad creative addressed to adult parents, and review the actual IARC questions shown in the console. Google explains that content ratings and intended audience are separate concepts in its [content-rating requirements](https://support.google.com/googleplay/android-developer/answer/9859655).

## 5. Reviewer access

The credential provisioning and clean-install test procedure is in [reviewer-access.md](./reviewer-access.md). The app intentionally commits a non-secret dedicated-email classifier, but never put the actual reviewer email, password, or any other secret in this document, EAS public variables, screenshots, release notes, or ordinary support messages. Keep the reusable credential pair only in the team's password manager and secure store-console fields.

### Apple App Review Information

- Sign-in required: **Yes**.
- Username/email: enter the dedicated reusable reviewer email only in App Store Connect's secure field.
- Password: enter the dedicated reusable password only in the secure field.
- Notes: use the App Store Connect wording in `docs/reviewer-access.md`.

Apple requires a working demo account or fully featured demo mode for account-based apps. See [App Review Guideline 2.1](https://developer.apple.com/app-store/review/guidelines/#performance).

### Google Play App access

- Access restriction: **All or some functionality is restricted**.
- Instruction name: `Momora reviewer access`.
- Credentials/instructions: use the Play Console wording in `docs/reviewer-access.md`.
- OTP/MFA: tell the reviewer to enter the dedicated supplied email on the normal Welcome back screen, tap **Continue**, then enter the password on the next step. This path does not require OTP.

Google requires credentials to remain reusable, location-independent, and valid at all times; OTP-dependent access must have a reusable bypass for review. See [Google's sign-in-detail requirements](https://support.google.com/googleplay/android-developer/answer/15748846) and [App content setup](https://support.google.com/googleplay/android-developer/answer/9859455).

**HUMAN CONFIRMATION REQUIRED:** Backend/account/media fixture verification is complete, but the email-triggered UI still must be tested from a clean install of the exact final build. Enter the reusable credential pair in both consoles. Do not use real child/family data. The code and docs alone do not complete this task.

## 6. IAP and monetization cleanup

Repository evidence: the current app declares no StoreKit/Play Billing/RevenueCat/IAP package and contains no paywall, product ID, entitlement, subscription, credit, or purchase flow. The Terms say the current version has no purchases.

### Apple

1. App Store Connect → Monetization → In-App Purchases: remove every old one-time product from sale in every territory. Confirm each status becomes **Developer Removed from Sale**. Apple documents that status and says prior purchasers retain access in [In-App Purchase statuses](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-statuses).
2. Monetization → Subscriptions: for every old subscription, clear **Cleared for Sale** / remove all availability. Apple documents the process in [Set availability for an auto-renewable subscription](https://developer.apple.com/help/app-store-connect/manage-subscriptions/set-availability-for-an-auto-renewable-subscription).
3. Remove promoted IAPs, subscription promotional images, review notes, offer codes, and store-listing copy/screenshots that imply payment.
4. Keep the app price **Free** and do not attach any IAP to the submitted version.
5. Verify Sales and Trends / subscription reports show zero active subscribers, billing-retry/grace-period users, and unfulfilled purchases as of the cutoff.

### Google Play

1. Monetize with Play → Products → One-time products: deactivate every active purchase option. Google's current steps are in [Overview of one-time products](https://support.google.com/googleplay/android-developer/answer/16430488).
2. If a migrated legacy product shows **Inactive: Visible in Play Billing Library**, follow Google's documented reactivate-then-deactivate sequence so it is no longer returned by Play Billing Library.
3. Monetize with Play → Products → Subscriptions: deactivate every base plan and offer. Do not reuse historical product IDs; Google says inactive base plans stop new purchases while subscription history remains in [Understanding subscriptions](https://support.google.com/googleplay/android-developer/answer/12154973).
4. Remove store-listing, promotional-content, and review-note references to subscriptions, credits, trials, premium access, or purchases.
5. Confirm **Contains ads: No**, and verify there is no paid-app price or in-app-product badge implied by the final listing.
6. Verify Play financial/subscription reports show zero active, paused, grace-period, account-hold, pending, or unacknowledged transactions.

### No migration/refund path

No subscriber migration or refunds are planned because there are no current purchases or subscribers. **HUMAN CONFIRMATION REQUIRED:** Treat that as true only after both stores' transaction/subscription reports confirm zero. Save dated report screenshots or exports in the team's private release records, not in git. If either store shows an active entitlement or transaction, stop and handle that user before disabling service.

After cleanup, test a clean install and an upgrade from the last public binary. No purchase UI should appear, old products should not be purchasable, and journal access must not depend on an old entitlement.

## 7. UGC and AI reviewer notes

Apple requires filtering, in-app reporting with timely responses, user blocking, and published contact information for UGC apps. Google requires ongoing moderation; for UGC shared with a specified set of users it specifically requires in-app reporting of content and users, and generative-AI apps require in-app reporting of offensive AI output. See [Apple App Review Guideline 1.2](https://developer.apple.com/app-store/review/guidelines/#user-generated-content), [Google's UGC policy](https://support.google.com/googleplay/android-developer/answer/9876937), and [Google's AI-generated-content policy](https://support.google.com/googleplay/android-developer/answer/13985936).

### Draft reviewer note — paste only after final-build verification

> Momora is an adults-only, private family memory journal. Content is visible only to authenticated members of an invite-only household; there is no public feed, discovery, anonymous chat, or content amplification. An owner or manager approves household access.
>
> From the nearby overflow or action menu, an active household member can report a memory, comment, household account, family profile, AI-generated character portrait, or AI-generated memory illustration. Reports are private to Momora. After a report, the item is obscured for the reporter, who can choose Show anyway; the report does not automatically delete the item for the rest of the household while it is reviewed.
>
> Report account and Block account are separate, clearly labeled actions. Block/Unblock is scoped to that household and controls the blocking member's view of the other account's authored memories, comments, and related notifications. Owners and managers can also remove a non-owner household member and delete journal content. Non-owner members can leave the household.
>
> Momora's Terms prohibit abusive, exploitative, illegal, privacy-invasive, and rights-infringing content. AI portrait and illustration generation uses server-side safety processing before output is generated. Momora reviews reports and can remove content or restrict accounts when appropriate. Support and safety contact: hello@usemomora.com.

### Reviewer verification path

With the seeded reviewer account, provide exact steps for these checks in the submission notes:

1. Open a memory → overflow menu → verify **Report memory** and, when present, **Report AI illustration**.
2. Open a comment's action menu → verify **Report comment**.
3. Open a family profile/portrait action menu → verify profile and AI-portrait reporting.
4. Open household members → account actions → verify separate **Report account** and **Block account**, then **Unblock account**.
5. Verify owner/manager removal and non-owner leave on the role-appropriate seeded account, or explain the role boundary if the single reviewer account cannot demonstrate both.
6. Settings → verify Terms, Privacy Policy, and **Contact support**.

**HUMAN CONFIRMATION REQUIRED:** Do not paste the note until all named actions exist and work in the exact submitted iOS and Android binaries, reports reach an operator-visible review queue, the support inbox is monitored, and a documented timely response/removal/suspension process exists. A family-scoped personal block is not the same as a global account suspension; describe it exactly as implemented. Also verify that objectionable non-AI UGC has an actual filtering/moderation control sufficient for Apple's Guideline 1.2—Terms plus post-hoc reporting alone may not satisfy Apple's filtering requirement.

## Final manual checklist

- [ ] Compare this draft to the final iOS privacy manifest/native dependency report and Android merged manifest/SDK index.
- [ ] Resolve the Apple Audio Data transient-processing gate.
- [ ] Resolve Google service-provider contracts and pasted-link sharing gate.
- [ ] Publish the live Privacy Policy and deletion URLs; open them logged out.
- [ ] Enter and publish Apple App Privacy answers.
- [ ] Enter and submit Google Data Safety answers.
- [ ] Complete Apple age questionnaire and verify 18+ regional override.
- [ ] Select Google 18+ only and enable Restrict minor access.
- [ ] Provision, seed, and clean-install-test reviewer access; enter credentials only in secure console fields.
- [ ] Remove/deactivate every Apple and Google IAP/subscription product and verify zero transactions/subscribers.
- [ ] Verify UGC/AI report, block/unblock, removal/leave, moderation queue, and support response from the final build.
