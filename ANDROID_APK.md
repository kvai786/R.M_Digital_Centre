# Building the Android APK

The APK is a Capacitor shell that loads the deployed HTTPS portal (the backend stays on the server).

1. Set `server.url` and `server.allowNavigation` in `capacitor.config.json` to your deployed HTTPS domain.
2. `npm install`
3. `npm run android:add` (first time only), then `npm run android:sync`
4. Open `android/` in Android Studio, or run `npm run android:build`.
5. Sign the release build with your own keystore (never commit it).

Security defaults: HTTPS only, no cleartext or mixed content, WebView debugging off, navigation limited to your domain.
Only public web assets are copied to `www/` (see `scripts/prepare-www.js`).
