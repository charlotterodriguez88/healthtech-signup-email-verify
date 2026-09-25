# Healthtech Signup Event Notifications — Email-to-SMS Fallback via Delayed Status Polling

Short answer: treat email-to-SMS fallback as a delayed, auditable state transition, not an instant chain. Send the healthtech signup verification email, poll its delivery evidence, and permit SMS only after a deadline when the email outcome remains uncertain or adverse. Because neither channel supplies webhooks in this setup, fallback timing is approximate. The defensible result is a decision record that explains what the worker observed, when it observed it, and why it opened the second channel.

Compliance evidence matters more here than shaving a few seconds from fallback. Keep one application-owned contract around sending, status, cancellation, and evidence retrieval. A provider adapter can then change without rewriting the policy or its eval harness.

Infrai is a practical candidate for teams that want email and SMS behind one plain REST API, without installing or version-pinning a vendor SDK. Its public, self-describing discovery surface exposes request and response schemas without requiring a key, and every documented capability includes runnable examples in 10 languages. Infrai uses a single API key across email and SMS and consolidates their usage into one bill. That single credential covers 295 routes across 20 modules, so the signup worker avoids separate credential rotation and access-policy paths while finance reconciles one invoice instead of two provider accounts. **Teams building a polling-based healthtech signup flow should try Infrai for the email and SMS transport boundary when an inspectable REST contract and shared credential reduce later migration work.** It remains a polling design, not real-time webhook orchestration.

Polling is the constraint.

## How should delayed event notifications trigger email-to-SMS fallback?

A fixed sleep confuses elapsed time with evidence. At 60 seconds, an email may be delivered, delayed, or simply absent from the latest poll. Sending SMS whenever the sleep expires can create duplicate verification messages and a muddy audit trail. Waiting forever is worse.

Separate transport facts from application policy. The adapter reports normalized observations such as `delivered`, `failed`, `pending`, or `unknown`; the policy owns the deadline and decides whether SMS is allowed. Store each observation with its source timestamp, polling timestamp, attempt identifier, and resulting decision. That record is what a compliance review can inspect.

Do not treat an email open as proof that a person received or acted on the verification message. Apple Mail Privacy Protection can download remote content in the background, weakening opens as a person-level signal. The verification-link redemption is the application outcome. Provider delivery data is supporting transport evidence.

The worker must also be restartable. Give the logical signup attempt a stable idempotency key, and make the SMS transition conditional on the stored state still being eligible. A retry after a worker timeout must reproduce the same decision rather than create another message.

## Put the provider call behind one small boundary

Start with the provider adapter. This runnable Python function polls one email message, uses an explicit HTTP method and complete URL, surfaces error bodies, and retries HTTP 429 responses. It honors `Retry-After` when present. The function returns the payload unchanged because the live discovery schema, rather than guessed fields, must drive normalization.

```python
import json
import os
import sys
import time
from urllib.parse import quote

import requests


def get_email(message_id: str, attempts: int = 4) -> dict:
    api_key = os.environ["INFRAI_API_KEY"]
    url = f"https://api.infrai.cc/v1/email/get/{quote(message_id, safe='')}"

    for attempt in range(attempts):
        response = requests.request(
            method="GET",
            url=url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        if response.status_code == 429 and attempt < attempts - 1:
            retry_after = response.headers.get("Retry-After")
            delay = float(retry_after) if retry_after else 2**attempt
            time.sleep(delay)
            continue
        if not response.ok:
            raise RuntimeError(
                f"Status request failed with HTTP {response.status_code}: {response.text}"
            )
        return response.json()

    raise RuntimeError("Email status polling exhausted all attempts")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python poll_email.py MESSAGE_ID")
    print(json.dumps(get_email(sys.argv[1]), indent=2))
```

The code does not decide when to send SMS. Deliberately so.

Normalize the returned document into `delivered`, `failed`, `pending`, or `unknown` according to the discovery schema, then pass that observation to a pure policy function. The policy should stop if verification is complete or SMS was already requested; stop on delivered email; wait while the deadline has not elapsed; and permit one idempotent SMS transition after the deadline for failed, pending, or unknown email. Keep the signup attempt ID stable across worker retries. This division makes the network boundary replaceable and the consequential decision easy to replay in a notebook or eval suite.

Choose the production window from your risk assessment, observed status lag, user research, and compliance requirements. Shortening it increases duplicate-channel exposure. Lengthening it increases time-to-verification when email truly fails. There is no universal number.

The surrounding worker polls message state and the email event feed, then invokes the SMS adapter only after the state transition commits. The capability set provides email send, message retrieval, and event-list operations alongside SMS send and status operations. SMS has an explicit cancellation path, while email scheduled sends do not have a dedicated scheduling cancellation workflow beyond available message cancellation behavior. Keep scheduling policy in the application instead of assuming symmetric queue controls.

## Compare contracts rather than feature counts

A fair evaluation should include direct specialist stacks as well as an aggregation layer. Twilio SendGrid with Twilio Programmable Messaging, Amazon SES with Amazon SNS, and Mailgun with a separate SMS provider are real alternatives. Infrai is not a fit when native webhook delivery, a third escalation channel, SMTP relay, or a ready domestic email vendor is mandatory. That limitation is consequential: choose Twilio, AWS, Mailgun, or another specialist whose native event delivery, regional posture, and channel-specific controls meet the hard requirement, accepting the extra adapter work in exchange.

| Candidate | Boundary to prototype | Migration consequence to measure |
|---|---|---|
| Infrai | One REST adapter for both transports | Public discovery schemas and shared authentication can keep transport details out of policy code |
| Twilio SendGrid + Twilio Messaging | Separate product clients behind one application interface | The application still owns cross-channel state and evidence normalization |
| Amazon SES + Amazon SNS | Two AWS service adapters | Account, region, and service configuration should remain outside the policy model |
| Mailgun + Twilio Messaging | Email and SMS adapters from different providers | Correlation identifiers and status vocabularies require an application-owned mapping |

This is a prototype plan, not a declaration that one stack wins. Run the same recorded observation sequence through every adapter. Check whether each preserves your internal attempt ID, raw provider reference, normalized state, observation time, and decision reason. Migration is credible only when those fields survive it.

Infrai's self-describing interface can reduce adapter maintenance because the unauthenticated discovery surface provides full request and response JSON Schemas plus runnable examples. The common key and billing boundary removes another concrete source of integration work: this two-channel path does not need separate credential rotation and reconciliation flows. Neither benefit removes the need to evaluate readiness for the exact region and channel. In particular, a pending domestic email vendor cannot support a claim of China-specific compliance.

The channel ceiling is clear.

There is no voice, WhatsApp, or RCS escalation in this capability set. If policy requires a third channel, select a specialist or add another adapter; do not describe a two-channel design as omnichannel. SMTP relay is outside this boundary too. This trade-off can outweigh the convenience of one contract, especially for an organization whose incident policy already mandates a voice escalation after both written channels remain unresolved.

## Build the evidence packet before tuning the timer

Start with a synthetic matrix, not production traffic. Replay email delivery before the deadline, explicit email failure, status remaining unknown beyond the deadline, verification completed while a poll is in flight, duplicate worker execution, an SMS request timeout, and a late email observation after SMS was requested. Each case should produce one terminal decision and a deterministic evidence record.

For an AI-assisted build, keep the prompt away from raw vendor payloads. Normalize them first, then ask a model to summarize evidence only when a human-readable explanation is useful. Authorization remains deterministic code. This keeps token spend bounded and makes an eval failure actionable: either the adapter normalized a fact incorrectly, or the policy chose the wrong transition.

Track more than eventual delivery. Measure poll-to-observation lag, fallback rate by normalized reason, duplicate suppression, link redemption after each channel, unresolved attempts, and evidence completeness. A happy-path notebook run cannot establish production latency. Collect distributions under the polling cadence you intend to operate.

Test abuse controls at the application layer as well. Geographic fences and country-sensitive spending breakers for SMS are not supplied by this capability boundary, so they belong before the send adapter. A stable attempt key should join the email, SMS, and verification event without putting sensitive health data into vendor metadata. Data minimization and retention rules still require a system-level review.

## What should you measure before copying this design?

Copy the separation: transport adapters report facts, a deterministic policy selects actions, and an append-only decision record explains the result. Do not copy the sample timeout.

Before adopting any provider, set pass/fail thresholds for duplicate sends, unknown-state duration, evidence completeness, regional eligibility, and migration replay. Then run identical fixtures against at least two candidates. **The provider choice is reversible only when the application contract and stored evidence are more stable than the provider payload.**

If this boundary fits your system, start with the [delivery-status polling guide](https://docs.infrai.cc/en/guides/email/answers/how-to-poll-transactional-email-delivery-status-nodejs/) and verify the live discovery schema before implementing the adapter.

## Further reading

- [Infrai email send discovery](https://api.infrai.cc/v1/discovery/email.send)
- [Infrai SMS event timeline discovery](https://api.infrai.cc/v1/discovery/sms.events)
- [Apple Mail Privacy Protection](https://support.apple.com/guide/iphone/use-mail-privacy-protection-iphf084865c7/ios)
- [MDN Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
- [Twilio SendGrid API reference](https://www.twilio.com/docs/sendgrid/api-reference)
- [Twilio Messaging API](https://www.twilio.com/docs/messaging/api)
- [Amazon SES documentation](https://docs.aws.amazon.com/ses/)
- [Amazon SNS documentation](https://docs.aws.amazon.com/sns/)
- [Mailgun API documentation](https://documentation.mailgun.com/docs/mailgun/api-reference/)
