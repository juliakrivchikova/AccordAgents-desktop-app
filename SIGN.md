# Signing AccordAgents

Use this when `.env.local` is already provided.

## Agent Runbook: User Asks for a Signed DMG

1. Do not use `npm run make` as the deliverable. A plain Forge DMG is only a
   packaging check and is not the signed/notarized distribution artifact.

2. Confirm the signing environment is available without printing secrets:
   ```bash
   security find-identity -p codesigning -v
   ```

   The keychain must include the `Developer ID Application` identity matching
   `APPLE_CODESIGN_IDENTITY`.

3. Use `.env.local` if it exists; this is the expected no-extra-input path for
   repeat signed DMG requests. If it is missing, ask the user to restore
   `.env.local` in the repo root from their secure local copy/password manager.
   Do not ask the user to re-explain the signing process. Use Apple signing
   values only from a user-approved source for the current build command. Never
   commit or document Apple IDs, app-specific passwords, certificate passwords,
   or `.p12` files.

4. Build the signed and notarized arm64 DMG:
   ```bash
   npm run signed:mac-arm64
   ```

   The script cleans `out/` and `signed/`, runs typecheck, packages the app,
   signs the app bundle, notarizes and staples the app, signs/notarizes/staples
   the DMG, then copies the finished artifact into `signed/`.

5. Report only the artifact path, checksum, and validation result:
   ```bash
   shasum -a 256 signed/AccordAgents-*-arm64.dmg
   cat signed/AccordAgents-*-arm64.dmg.sha256
   xcrun stapler validate "$(pwd)/signed/AccordAgents-0.1.0-arm64.dmg"
   spctl -a -vv --type open --context context:primary-signature "$(pwd)/signed/AccordAgents-0.1.0-arm64.dmg"
   codesign --verify --verbose=2 "$(pwd)/signed/AccordAgents-0.1.0-arm64.dmg"
   ```

   In sandboxed agent sessions, `stapler`, `spctl`, and `codesign` checks may
   need native/escalated execution because macOS code-signing services can fail
   with false file-open or internal Code Signing errors inside the sandbox.

6. If signing fails with `A timestamp was expected but was not found` for a
   loose Electron data resource such as `locale.pak`, do not hand out that
   artifact. Keep the `forge.config.ts` loose-resource signing skip in place and
   rerun `npm run signed:mac-arm64`.

## Restoring the Local Signing Environment

If an agent reports that the signing environment is missing, it means one of
these local-only prerequisites is absent:

- `.env.local` in the repo root with:
  - `APPLE_CODESIGN_IDENTITY`
  - `APPLE_TEAM_ID`
  - `APPLE_NOTARIZE_APPLE_ID`
  - `APPLE_NOTARIZE_PASSWORD`
  - `MACOS_BUNDLE_ID`
- the matching `Developer ID Application` certificate and private key imported
  into the macOS login Keychain.

Agents should first ask the user to restore `.env.local` from their secure local
copy/password manager. If `security find-identity -p codesigning -v` still does
not show the matching `Developer ID Application` identity, ask the user to import
the `.p12` certificate into Keychain Access. Do not commit `.env.local`,
`.p12`, or certificate passwords.

## One-Time Setup

1. Install Xcode from the App Store.

2. Select Xcode command line tools:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   xcrun notarytool --version
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Put the provided `.env.local` in the project root.

5. Import the provided `Developer ID Application` certificate `.p12` into
   Keychain Access:
   - open `Keychain Access`;
   - select the `login` keychain;
   - double-click the `.p12`;
   - enter the `.p12` password;
   - confirm it appears under `My Certificates` with a private key.

6. Verify the certificate identity exists:
   ```bash
   security find-identity -p codesigning -v
   ```

   The output must include the exact `APPLE_CODESIGN_IDENTITY` value from
   `.env.local`.

## Build

Run from any branch:

```bash
npm run signed:mac-arm64
```

The finished files will be in `signed/`:

```text
AccordAgents-<version>-arm64.dmg
AccordAgents-<version>-arm64.dmg.sha256
```

## If macOS Asks for Keychain Access

Allow `codesign`, `xcrun`, or `electron-osx-sign` to use the private key.
Choose `Always Allow` if available.
