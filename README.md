# IPA Signer (Railway)

## Required variables
- `SITE_PASSWORD`: at least 16 characters; Basic Auth password (username is `ipa`).
- `PUBLIC_BASE_URL`: public HTTPS Railway URL, e.g. `https://your-service.up.railway.app`.
  If `RAILWAY_PUBLIC_DOMAIN` is available, the app derives this automatically.

## OTA installation
After signing, open the site in Safari on the registered iPhone and tap **이 iPhone에 설치**.
The app creates a short-lived (2-hour) random-token manifest and IPA URL. The OTA endpoints are
intentionally exempt from Basic Auth because iOS installation cannot reliably authenticate
against Basic Auth-protected manifest and IPA URLs. Treat generated install links as private.

The device UDID must be included in the provisioning profile used for signing. The certificate,
profile, app identifier, and entitlements must also match. The server cannot bypass Apple's
provisioning requirements.

## Deploy
Replace the files in the existing project with the matching paths, commit to GitHub, and redeploy
on Railway. If using a repository subfolder, keep Railway Root Directory pointed at that folder.
