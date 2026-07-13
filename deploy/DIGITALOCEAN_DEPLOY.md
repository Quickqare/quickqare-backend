## QuickQare DigitalOcean Deploy

### 1. Prepare server

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. Backend deploy path

```bash
sudo mkdir -p /var/www/quickqare-backend
sudo chown -R $USER:$USER /var/www/quickqare-backend
cd /var/www/quickqare-backend
```

### 3. Upload backend code

Use git clone or upload your project files into:

```bash
/var/www/quickqare-backend
```

### 4. Create production env

```bash
cp .env.example .env
nano .env
```

Set real values for:
- `MONGO_URI`
- `JWT_SECRET`
- `PUBLIC_BASE_URL`
- `CORS_ALLOWED_ORIGINS`
- `GOOGLE_MAPS_SERVER_API_KEY`
- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `R2_*` (Cloudflare R2 upload storage)
- admin JWT secrets

### 5. Install and start backend

```bash
npm install
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### 6. Nginx for backend

```bash
sudo cp deploy/nginx.quickqare.conf.example /etc/nginx/sites-available/quickqare-api
sudo ln -s /etc/nginx/sites-available/quickqare-api /etc/nginx/sites-enabled/quickqare-api
sudo nginx -t
sudo systemctl reload nginx
```

Update `server_name` in the file before reload.

### 7. Enable HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

### 8. Health check

```bash
curl https://api.yourdomain.com/health
```

### 9. Admin deploy on same droplet

Recommended path:

```bash
/var/www/quickqare-admin
```

Build admin after setting `VITE_ADMIN_API_BASE_URL`.

Serve the generated `dist` using Nginx with `try_files /index.html`.

### 10. Firewall — do this BEFORE pointing DNS at the droplet

Only nginx should be reachable from the internet. The Node app must only be
reachable via nginx on loopback (docker-compose already publishes
`127.0.0.1:4000:4000`; keep it that way — never `4000:4000`).

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH        # port 22 — lock to your IP if it is static:
                              #   sudo ufw allow from <your-ip> to any port 22
sudo ufw allow 'Nginx Full'   # 80 + 443
sudo ufw enable
sudo ufw status verbose       # verify: ONLY 22, 80, 443 allowed
```

Notes:
- **Docker bypasses ufw** for published ports (it writes its own iptables
  rules). That's exactly why the compose file binds to `127.0.0.1` — a
  loopback-published port is unreachable externally regardless of iptables.
  If you add more services to compose, bind those to `127.0.0.1` too.
- If MongoDB runs on this droplet, bind it to `127.0.0.1` in `mongod.conf`
  and never open 27017 in ufw. If you use Atlas, allowlist only the droplet's
  IP in Atlas Network Access.
- Optionally add DigitalOcean's Cloud Firewall with the same 22/80/443 rules
  as a second, Docker-proof layer in front of the droplet.
- SSH hardening: disable password auth (`PasswordAuthentication no` in
  `/etc/ssh/sshd_config`, keys only) and install fail2ban
  (`sudo apt install -y fail2ban`).

### 11. Logging, monitoring & alerts — set up BEFORE launch

The app writes structured JSON logs to stdout; Docker captures them.

```bash
docker compose logs -f backend                 # tail live logs
docker compose logs --since 1h backend | grep -i error
```

Keep logs from eating the disk (droplets are small) — add rotation once in
`/etc/docker/daemon.json`, then restart docker:

```json
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
```

Minimum monitoring for launch (all free tiers):
1. **Uptime**: point UptimeRobot / Better Stack / DO Uptime at
   `https://api.yourdomain.com/health` (checks Mongo connectivity too — it
   returns 503 when the DB is down) and at `https://yourdomain.com`. Alert to
   email + phone.
2. **Error tracking**: add Sentry (`@sentry/node`) or a similar tracker so
   unhandled errors page you instead of dying silently in `docker logs`.
   Until then, at least grep logs daily for `"level":"error"`.
3. **Droplet metrics**: enable the DigitalOcean monitoring agent and set
   alert policies for disk > 80%, memory > 90%, CPU sustained > 90%.
4. **Watch for these log tags** (worth alerting on if you ship logs anywhere):
   - `COUPON_BUDGET_OVERRUN` — a paid booking got a discount past the
     coupon's global usage limit (needs reconciliation).
   - `[rzp-webhook] Captured payment for non-payable booking` — money taken
     for a dead booking; it is auto-flagged `refundStatus: PENDING` and needs
     a manual refund.

### 12. MongoDB backups

- **Atlas**: enable Continuous / scheduled Cloud Backups on the cluster and
  test a point-in-time restore once before launch.
- **Self-hosted**: nightly `mongodump` to a different location than the
  droplet (e.g. DO Spaces or R2), e.g. a cron:
  `mongodump --uri "$MONGO_URI" --archive | gzip | rclone rcat r2:backups/mongo-$(date +%F).gz`
  and periodically verify a restore actually works.

### 13. When something breaks

See `deploy/INCIDENT_RESPONSE.md` — kill switches (emergency lockdown,
bookings/payments/payouts freezes), triage steps, and rollback commands.
