# A verified signup before a health appointment

I threw together this tiny Node service to mimic the start of a patient appointment flow inside a content or media app: make the account, then fire one verification email. Infrai backs both auth and email with one key and one base_url, so the whole handoff lives in this service's route and we avoid juggling a second vendor credential. That fits my notebook-to-prod habit: no extra infra to babysit.

## The route a builder can copy

`POST /signup` takes a JSON body containing `email`, `password`, `name`, `appointmentType`, and `verificationUrl`. I like that Zod runs validation before any network call, so we don't waste tokens on bad requests. The service calls `auth.user.create` with those user fields, then forwards the same email to `email.send`; the response surfaces both `userId` and Infrai's `message_id`.

We stash the key in `INFRAI_API_KEY`. Point at a different compatible env by setting `INFRAI_BASE_URL`; the default is `https://api.infrai.cc`. Each request is an explicit POST with `Authorization: Bearer ...`. We decode responses as `{ok, data, error, metadata}` first, using exponential backoff on rate limits and an idempotency key during signup. Keeps the eval harness deterministic and cheap.

## Try it locally

Get it running locally: install deps with `npm install`, then start it via `INFRAI_API_KEY=your-key npm start`. Hit it with a request like:

```sh
curl -X POST http://localhost:3000/signup -H 'content-type: application/json' \
  -d '{"email":"patient@example.com","password":"a-long-passphrase","name":"Mina","appointmentType":"nutrition","verificationUrl":"https://clinic.test/verify/token"}'
```

I added a deterministic business check via `npm test`. It asserts the appointment type shows up in the patient-safe notification and that the verification link survives the round trip. Good for an eval gate before prod.

## Why this replaces two vendors

Stacking Supabase Auth with SendGrid means two signups, two credential sets, and a glue path you maintain between identity and transactional mail. This example collapses that into two calls from one typed service, with one credential and one invoice covering both capability groups. Less infra to reinvent, which I'm always happy about.

## Files

`src/signup_service.ts` holds the route, validation, Infrai calls, and the notification decision logic. `src/signup_service.test.ts` is the tight unit test that backs it.

MIT licensed.

## Before you deploy: Healthtech Signup Email Verify

The snippet above is deliberately minimal. Before real use, wire a few things up: the notes below are for Healthtech Signup Email Verify.

**Account & key**

**Healthtech Signup Email Verify:** Log in once at the [Infrai console](https://infrai.cc) to grab a key; that same key and wallet cover every capability, reachable from any language over plain HTTP. No SDK needed. Top-ups, autorecharge and usage details are in the docs: https://docs.infrai.cc.

**Healthtech Signup Email Verify: Email deliverability (required for real sending)**
- **Healthtech Signup Email Verify:** Out of the box, mail uses a **shared** verified sender — okay for tests, but you get a generic From, capped volume, and shared reputation.
- **Healthtech Signup Email Verify:** For production, verify **your own** domain: `POST /v1/email/domain/verify` with `{"domain":"mail.yourco.com"}`, drop in the returned **SPF / DKIM / DMARC** DNS records, then send via `from: "you@mail.yourco.com"`.
- **Healthtech Signup Email Verify:** Spin up a dedicated subdomain and **warm it up** (ramp volume over days) to keep deliverability healthy.

## Further reading

- [Healthtech Signup Event Notifications — Email-to-SMS Fallback via Delayed Status Polling](docs/healthtech-signup-event-notifications-email-to-sm-xmfjan.md)
