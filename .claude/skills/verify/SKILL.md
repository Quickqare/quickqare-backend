---
name: verify
description: Boot the real backend locally (in-memory Mongo, no .env needed) and drive the HTTP API with curl to verify changes end-to-end.
---

# Verify quickqare-backend changes at the HTTP surface

No `.env` exists locally (prod env lives on the droplet). Boot the real
`index.js` against `mongodb-memory-server` (already a devDependency) via a
launcher script that seeds auth and mints JWTs.

## Boot recipe

Write a launcher (scratchpad) that, in order:
1. `MongoMemoryServer.create()` → set `process.env.MONGO_URI`
2. Set required env: `JWT_SECRET`, `ADMIN_JWT_ACCESS_SECRET`, `ADMIN_JWT_REFRESH_SECRET`, `PORT`
3. `process.chdir(<backend>)` then `require("<backend>/index.js")`
4. Wait for `mongoose.connection` connected, then seed:
   - `User.create({ name, phone })` → user JWT: `jwt.sign({ id, role: "user" }, JWT_SECRET)`
   - `AdminUser.create({ name, email, passwordHash: "x", role: "SuperAdmin", isActive: true })`
     + `AdminSession.create({ adminUserId, refreshExpiresAt: future })`
     → admin JWT: `jwt.sign({ type: "access", sub: adminId, sid: sessionId }, ADMIN_JWT_ACCESS_SECRET)`
5. Write tokens to a JSON file for curl; print a READY sentinel.

## Gotchas (all fatal at require-time — set fake values)

- `config/multerR2.js` throws without `R2_BUCKET_NAME` (+ set `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
- `admin/services/email.service.js` throws without `RESEND_API_KEY` (any `re_...` string works)
- Upload storage backend is chosen at require-time: `USE_LOCAL_UPLOADS=true` (disk),
  `UPLOAD_BACKEND=cloudinary`, default = R2 — restart the server to switch
- Windows: node/curl reject Git-Bash `/c/...` paths — pass `C:/...` paths to
  `require()` and curl `-F "image=@..."`
- express-rate-limit prints IPv6 ValidationErrors at boot — noise, not fatal

## Drive

```bash
curl -X POST http://127.0.0.1:<port>/api/upload/customer -H "Authorization: Bearer <userToken>" -F "image=@C:/path/test.png"
curl -X POST http://127.0.0.1:<port>/api/upload            -H "Authorization: Bearer <adminToken>" -F "image=@C:/path/test.png"
curl -X POST http://127.0.0.1:<port>/api/upload/multi      -H "Authorization: Bearer <adminToken>" -F "images=@a.png" -F "images=@b.png"
```

With `USE_LOCAL_UPLOADS=true`, GET the returned `/uploads/...` URL to confirm
serving; delete `<backend>/uploads/` test files after.

With fake R2 creds, an upload fails with TLS `SSL alert number 40` — that means
the request DID reach `\<account>.r2.cloudflarestorage.com` (Cloudflare SNI-rejects
unknown accounts); wiring is good, only real creds are untestable locally.

To observe generated R2 object keys/URLs end-to-end without real creds: in the
launcher, after `require(index.js)`, patch `require("config/r2.js").send =
async () => ({ ETag: '"stub"' })`. multer-s3/lib-storage computes `Location`
client-side (endpoint+bucket+key), so responses carry the real key while only
the network hop is faked.
