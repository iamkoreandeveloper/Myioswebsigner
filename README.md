# IPA Signer — Railway deployment

A self-hosted IPA re-signing web app using the open-source zsign CLI.

## Deploy
1. Push this folder to a private GitHub repository.
2. In Railway, create a project with **Deploy from GitHub Repo**.
3. Railway builds the included Dockerfile and compiles zsign.
4. Set the Railway variable `SITE_PASSWORD` to a long random value (at least 16 characters).
5. Deploy, then open Settings → Networking → Generate Domain.
6. Open the HTTPS domain. Basic Auth credentials: username `ipa`, password = `SITE_PASSWORD`.

## Important
- This is a starter implementation, not a security-audited signing service.
- P12, profile, IPA and password are sent to your server.
- zsign's CLI receives the P12 password as a process argument. Use only a trusted, isolated host; a hardened worker should avoid command-line password exposure.
- Temporary files are deleted after each request, but abrupt termination can leave files behind.
- Large IPAs require sufficient memory, CPU and temporary disk.
- Signing can fail if certificate, provisioning profile, entitlements, bundle ID or device registration do not match.
- Only sign apps and use certificates you are authorized to use.

## Local run
Requires Linux, Node.js 20+, and zsign installed.

```sh
npm install
SITE_PASSWORD='a-long-random-password-here' npm start
```
