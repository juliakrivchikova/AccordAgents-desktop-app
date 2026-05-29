# Signing AccordAgents

Use this when `.env.local` is already provided.

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
