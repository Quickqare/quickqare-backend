# QuickQare Backend Admin Module

This folder contains the structured admin domain inside the same backend service.

## Base URL

`/api/v1/admin`

## Core Structure

- `constants/permissions.js`: fixed v1 roles and permission map
- `middleware/*`: request context, auth, RBAC, audit
- `models/*`: admin auth/session/audit + admin ops entities
- `routes/v1/*`: versioned admin API routes
- `docs/openapi.admin.v1.yaml`: OpenAPI skeleton

## Bootstrap First Admin

Create the first admin user in MongoDB manually or via script with:

- `email`: admin email
- `passwordHash`: bcrypt hash of password
- `role`: `SuperAdmin`
- `twoFaEnabled`: `true`

## Required ENV

- `JWT_SECRET` (or `ADMIN_JWT_ACCESS_SECRET` + `ADMIN_JWT_REFRESH_SECRET`)
- `ADMIN_2FA_TEST_CODE` (optional, non-production fallback)
- `ADMIN_ACCESS_TTL_SECONDS` (optional)
- `ADMIN_REFRESH_TTL_SECONDS` (optional)
