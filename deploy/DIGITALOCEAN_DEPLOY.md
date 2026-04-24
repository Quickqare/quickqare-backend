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
- `CLOUDINARY_*`
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
