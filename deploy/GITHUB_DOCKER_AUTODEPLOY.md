## QuickQare Backend: GitHub -> Auto Deploy -> DigitalOcean (Docker) with .env on Server

This deploy flow keeps secrets out of GitHub:
- Code lives in GitHub
- The droplet pulls new code and rebuilds containers
- The production `.env` lives ONLY on the droplet and is not committed

### 1) One-time droplet setup

SSH in:

```bash
ssh root@YOUR_DROPLET_IP
```

Install docker:

```bash
apt update
apt -y install ca-certificates curl git
curl -fsSL https://get.docker.com | sh
docker --version
docker compose version
```

Clone repo:

```bash
mkdir -p /var/www
cd /var/www
git clone YOUR_GITHUB_REPO_URL quickqare-backend
cd /var/www/quickqare-backend
```

Create `.env` on droplet:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Start:

```bash
docker compose up -d --build
curl http://127.0.0.1:4000/health
```

### 2) Add GitHub Actions auto-deploy

You need these GitHub repository secrets (Repo -> Settings -> Secrets and variables -> Actions):
- `DO_HOST` = droplet IP
- `DO_USER` = `root` (or your deploy user)
- `DO_SSH_KEY` = private SSH key contents
- `DO_APP_DIR` = `/var/www/quickqare-backend` (optional, defaults to this path)

Workflow file:
- `.github/workflows/deploy-digitalocean.yml`

On each push to `main`, it will:
- `git pull`
- `docker compose up -d --build`

### 3) Typical redeploy command (manual on droplet)

```bash
cd /var/www/quickqare-backend
git pull origin main
docker compose up -d --build
docker image prune -f
```
