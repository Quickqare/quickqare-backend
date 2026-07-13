# QuickQare Incident Response Runbook

One page. Read it now, not during the incident. Update the contacts table
before launch — an empty table means "nobody is on call".

## 0. Contacts & roles

| Role | Who | Phone / handle |
| --- | --- | --- |
| Incident lead (decides, communicates) | FILL IN | FILL IN |
| Backend / server access | FILL IN | FILL IN |
| Razorpay dashboard access | FILL IN | FILL IN |
| MongoDB (Atlas) access | FILL IN | FILL IN |
| Domain / DNS / Cloudflare access | FILL IN | FILL IN |

Rule of thumb: **one person leads** an incident and does the talking; everyone
else executes. If you're alone, do the kill-switch step first, then triage.

## 1. Kill switches (fastest safe action)

The backend has product-level kill switches on `AdminSetting`, enforced inside
the booking / payment / payout endpoints (they return 503 with a JSON body the
apps understand — the apps show a maintenance banner, nothing crashes).

Flip them from the **admin panel → Settings → Emergency controls**, or via API
(needs an admin token with `SETTINGS_MANAGE`):

```bash
# Freeze ONLY new bookings (checkout of existing pending payments still works)
curl -X PATCH https://api.quickqare.in/api/v1/admin/settings/emergency \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"bookingsDisabled": true}'

# Freeze payments / payouts individually
#   {"paymentsFreezed": true}     – blocks new Razorpay orders
#   {"payoutsFreezed": true}      – blocks partner withdrawal requests

# FULL LOCKDOWN — blocks bookings + payments + payouts in one flag
curl -X PATCH https://api.quickqare.in/api/v1/admin/settings/emergency \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"emergencyLockdown": true}'
```

Un-freeze the same way with `false`. Every change is written to the admin
audit log with the acting admin's id.

When to use what:

| Situation | Switch |
| --- | --- |
| Payments double-charging / wrong amounts | `paymentsFreezed` |
| Coupon/promo being drained | `bookingsDisabled` (then deactivate the coupon) |
| Partner wallet balances look wrong | `payoutsFreezed` |
| Suspected breach, data leak, or "everything is on fire" | `emergencyLockdown` |

## 2. Triage — first 10 minutes

```bash
ssh <droplet>
docker compose ps                          # is the container up / restarting?
curl -s localhost:4000/health | jq .       # app + Mongo connectivity
docker compose logs --since 30m backend | grep '"level":"error"' | tail -50
df -h && free -m                           # disk/memory exhaustion is a classic
sudo systemctl status nginx && sudo nginx -t
```

Interpretation:
- `/health` 503 → Mongo is the problem (Atlas status page, network access
  list, disk full if self-hosted).
- Container restart-looping → `docker compose logs backend | head -100`; the
  app fails fast at boot on missing `MONGO_URI`/`JWT_SECRET` (validateEnv), so
  a bad `.env` edit shows up here.
- nginx up but 502/504 to users → app dead or bound wrong; the maintenance
  page is served automatically for these codes.
- Site up, users complain about a specific flow → check the log tags below.

Log tags that mean money needs manual attention:
- `[rzp-webhook] Captured payment for non-payable booking` — customer paid for
  a dead booking. It's already flagged `refundStatus: PENDING`; refund it in
  the Razorpay dashboard, then mark it processed in the admin panel.
- `COUPON_BUDGET_OVERRUN` — a paid booking got a discount beyond the coupon's
  global cap. Deactivate the coupon in admin, reconcile the overspend.
- `payoutStatus: "failed"` bookings — partner wallet credits exhausted retries;
  credit manually from the admin panel.

## 3. Rollback a bad deploy

Deploys are `git pull` + `docker compose up -d --build` (see the GitHub Action).
To roll back to the previous commit on the droplet:

```bash
cd /var/www/quickqare-backend
git log --oneline -5                # find the last good commit
git checkout <good-sha>
docker compose up -d --build
curl -s localhost:4000/health
```

(Or `git revert <bad-sha> && git push` from a laptop and let the action deploy —
slower but keeps main honest. After a manual droplet checkout, remember the
next push deploys main again.)

## 4. Suspected compromise (secrets/server)

In order:
1. `emergencyLockdown: true` (step 1).
2. Rotate what leaked — every one of these is revocable independently:
   Razorpay keys + webhook secret (dashboard), `JWT_SECRET` + admin JWT
   secrets (in `.env`, then `docker compose up -d` — this force-logs-out every
   user/partner/admin), MongoDB user password, R2 API tokens, MSG91 key,
   GitHub deploy SSH key (`DO_SSH_KEY` secret + `authorized_keys` on the box).
3. Check the admin audit log for actions you didn't make.
4. Preserve evidence: `docker compose logs backend > /root/incident-$(date +%F).log`
   before restarting anything, and snapshot the droplet in the DO panel.
5. Only lift the lockdown after you understand how they got in.

## 5. After the incident

Write 5 lines in a shared doc: what broke, when, blast radius (users/money),
what fixed it, what prevents a repeat. Create the follow-up ticket immediately
— "we'll remember" is how the same incident happens twice.
